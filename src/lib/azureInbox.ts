import { invoke } from "@tauri-apps/api/core";
import { loadAzureFilter, type AzureStatus } from "./azure";
import type { InboxItem } from "./githubTasks";

export type AzureInboxDelivery = {
  kind: "pr" | "ci";
  project: string;
  repository: string;
  repositoryType?: string;
  definition?: number;
  branch: string;
  commit: string;
  targetBranch?: string;
  author: string;
  accountId: string;
};
export async function listAzureDelivery(status: AzureStatus, state: "open" | "all") {
  const filter = loadAzureFilter(status.site, status.project);
  const result = await invoke<{items: (Omit<InboxItem,"provider"|"projectPath"|"labels"|"assignees"> & {delivery:AzureInboxDelivery})[]; errors:string[]}>("azure_delivery_inbox", {
    site:status.site,accountId:status.accountId,project:filter.project,assigned:filter.assigned,state,
  });
  return {
    items: result.items.map(item => ({...item,provider:"azure" as const,site:status.site,account:status.accountId,projectPath:"",id:String(item.number),identifier:`${item.kind === "ci" ? "Run" : "PR"} #${item.number}`,labels:[],assignees:[]})),
    errors:result.errors,
  };
}


/** Uses the same selected-context picker and revalidation path as other Inbox providers. */
export async function azureDeliveryContext(item: InboxItem, pages: number): Promise<import("./inboxContext").ContextDocument> {
  const delivery=item.delivery!;
  const owner=`azure:${item.site}:${delivery.accountId}`;
  if(delivery.kind==="ci") {
    const fresh=await invoke<InboxItem>("azure_ci_inbox_summary",{site:item.site,accountId:delivery.accountId,project:delivery.project,number:item.number});
    if(fresh.delivery?.repository!==delivery.repository || fresh.delivery?.definition!==delivery.definition) throw new Error("Pipeline identity changed. Refresh Inbox.");
    return {owner,description:[fresh.title, fresh.url, `Status: ${fresh.state}`, `Pipeline: ${fresh.delivery.definition}`, `Repository: ${fresh.delivery.repository}`, `Branch: ${fresh.delivery.branch}`, `Commit: ${fresh.delivery.commit}`, `Requested by: ${fresh.delivery.author}`].join("\n\n"),comments:[],files:[],more:false};
  }
  const {readAzurePr,readAzurePrSection}=await import("./azureRepos");
  const target={site:item.site!,accountId:delivery.accountId,project:delivery.project,repository:delivery.repository,number:item.number};
  const fresh=await readAzurePr(target);
  const comments:import("./inboxContext").ContextComment[]=[];
  let more=false;
  for(let page=0;page<Math.min(5,Math.max(1,pages));page++) {
    const result=await readAzurePrSection<import("./azureRepos").AzurePrThread>(target,fresh.revision,"threads",page*50);
    for(const thread of result.items) if(!thread.isDeleted) for(const comment of thread.comments) if(!comment.isDeleted && comment.content?.trim()) comments.push({id:`${thread.id}:${comment.id}`,body:comment.content,author:comment.author?.displayName || "Unknown",createdAt:"",updatedAt:""});
    more=result.nextSkip!==null;
    if(!more)break;
  }
  return {owner,description:[fresh.pr.title, fresh.pr.description || "", `Branch: ${fresh.pr.sourceRefName}`, `Revision: ${fresh.revision}`].filter(Boolean).join("\n\n"),comments:comments.slice(0,750),files:[],more:more||comments.length>750};
}
