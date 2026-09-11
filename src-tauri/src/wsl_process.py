"""An app-owned Linux process group; no socket, daemon or credential copying."""
import json
import os
import signal
import select
import subprocess
import sys
import time


def start_time(stat):
    # comm may contain spaces and parentheses; fields after its final ')' start
    # with field 3, and starttime is field 22.
    return int(stat.rsplit(")", 1)[1].split()[19])


def identity(pid):
    with open("/proc/%d/stat" % pid, encoding="utf-8") as stream:
        return start_time(stream.read(8192))


def boot_id():
    with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as stream:
        return stream.read(64).strip()


def stop(pid, started, boot):
    if pid <= 1 or started <= 0:
        raise ValueError("Invalid Linux process identity")
    try:
        if boot_id() != boot:
            raise ValueError("WSL restarted; the old process identity was discarded")
        descriptor = os.pidfd_open(pid)
        try:
            if identity(pid) != started or os.getpgid(pid) != pid:
                raise ValueError("Linux process identity changed; nothing was signalled")
            # A pidfd binds the signal to this process even if its PID is reused.
            signal.pidfd_send_signal(descriptor, signal.SIGTERM)
            poll = select.poll()
            poll.register(descriptor, select.POLLIN)
            if not poll.poll(5000):
                raise TimeoutError("Linux agent cleanup did not finish; retry cancellation")
        finally:
            os.close(descriptor)
    except ProcessLookupError:
        pass
    except FileNotFoundError:
        pass


def start(config):
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise ValueError("WSL agents require WSL 2 and Python 3.9 or newer for safe cancellation")
    descriptor = os.pidfd_open(os.getpid())
    os.close(descriptor)
    command, args = config["command"], config["args"]
    if not command or "\\" in command or ":" in command or "\0" in command:
        raise ValueError("Choose a Linux agent executable")
    if not isinstance(args, list) or len(args) > 512 or any(not isinstance(arg, str) or "\0" in arg for arg in args):
        raise ValueError("Invalid Linux agent arguments")
    if os.getpgrp() != os.getpid():
        os.setsid()
    cancelled = False

    def cancel(_number, _frame):
        nonlocal cancelled
        cancelled = True
        raise InterruptedError("Agent cancelled")

    signal.signal(signal.SIGTERM, cancel)
    os.write(1, (json.dumps({"nonce": config["nonce"], "pid": os.getpid(), "started": identity(os.getpid()), "boot": boot_id()}) + "\n").encode())
    # Read exactly the barrier, without buffering the first provider message.
    barrier = bytearray()
    while len(barrier) < 1024 * 1024:
        byte = os.read(0, 1)
        if not byte:
            return 125
        barrier.extend(byte)
        if byte == b"\n":
            break
    acknowledgement = json.loads(barrier)
    if acknowledgement.get("nonce") != config["nonce"]:
        raise ValueError("Invalid process-start acknowledgement")
    environment = acknowledgement["environment"]
    if not isinstance(environment, dict) or any(not isinstance(k, str) or not isinstance(v, str) or "\0" in k + v or "=" in k for k, v in environment.items()):
        raise ValueError("Invalid Linux environment")
    environment["PWD"] = config["cwd"]
    child = None
    code = 125
    try:
        child = subprocess.Popen([command, *args], cwd=config["cwd"], env=environment)
        code = child.wait()
    except InterruptedError:
        cancelled = True
    finally:
        if cancelled:
            # Keep this group leader alive through escalation: no recycled PID
            # or unrelated distribution can become the cleanup target.
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            os.killpg(os.getpid(), signal.SIGTERM)
            time.sleep(0.2)
            os.killpg(os.getpid(), signal.SIGKILL)
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    try:
        if sys.argv[1] == "stop":
            stop(int(sys.argv[2]), int(sys.argv[3]), sys.argv[4])
        else:
            sys.exit(start(json.loads(sys.argv[2])))
    except Exception as error:
        print("WSL process: %s" % error, file=sys.stderr)
        sys.exit(125)
