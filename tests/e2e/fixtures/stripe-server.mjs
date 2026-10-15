// Isolated Stripe HTTP simulation. No request reaches Stripe or uses real credentials.
import { createServer } from "node:http";
const intents = new Map(), refunds = new Map(), requests = new Map();
const failNextRefund = new Set(), refundDispatches = [];
let next = 0;
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "http://localhost:3100");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.end(); return; }
  const chunks=[]; for await (const chunk of req) chunks.push(chunk);
  const raw=Buffer.concat(chunks).toString(); const body=new URLSearchParams(raw);
  const path=new URL(req.url,"http://127.0.0.1:3111").pathname;
  const reply=(data,status=200)=>{res.statusCode=status;res.end(JSON.stringify(data));};
  if(path==="/health") return reply({ok:true});
  if(path==="/fixture/payment" && req.method==="POST") {
    const {id,amount,attemptId,failRefund}=JSON.parse(raw);
    const intent={id,object:"payment_intent",amount,amount_received:amount,currency:"ron",status:"succeeded",metadata:{payment_attempt_id:attemptId}};
    intents.set(id,intent);
    if(failRefund) failNextRefund.add(id);
    return reply(intent);
  }
  if(path==="/fixture/evidence" && req.method==="GET") {
    const paymentId=new URL(req.url,"http://127.0.0.1:3111").searchParams.get("paymentId");
    return reply({payment:intents.get(paymentId),refunds:[...refunds.values()].filter(r=>r.payment_intent===paymentId),
      dispatches:refundDispatches.filter(r=>r.paymentId===paymentId)});
  }
  if(path==="/fixture/payment" && req.method==="DELETE") {
    const {id}=JSON.parse(raw);
    intents.delete(id); failNextRefund.delete(id);
    for(const [refundId,refund] of refunds) if(refund.payment_intent===id) refunds.delete(refundId);
    for(const [requestKey,response] of requests) if(response.id===id || response.payment_intent===id) requests.delete(requestKey);
    for(let i=refundDispatches.length-1;i>=0;i--) if(refundDispatches[i].paymentId===id) refundDispatches.splice(i,1);
    return reply({ok:true});
  }
  if(path==="/fixture/confirm") {
    const id=JSON.parse(raw).id; const intent=intents.get(id);
    if(!intent) return reply({error:"Missing intent"},404);
    intent.status="succeeded"; intent.amount_received=intent.amount; return reply(intent);
  }
  const key=req.headers["idempotency-key"];
  if(req.method==="POST" && key && requests.has(key)) return reply(requests.get(key));
  if(path==="/v1/payment_intents" && req.method==="POST") {
    const id=`pi_fixture${++next}`;
    const intent={id,object:"payment_intent",amount:Number(body.get("amount")),amount_received:0,
      currency:body.get("currency"),status:"requires_payment_method",client_secret:`${id}_secret_fixture`,
      metadata:{payment_attempt_id:body.get("metadata[payment_attempt_id]")}};
    intents.set(id,intent); if(key) requests.set(key,intent); return reply(intent);
  }
  const intentId=path.split("/")[3];
  if(path.startsWith("/v1/payment_intents/") && intents.has(intentId)) {
    const intent=intents.get(intentId);
    if(path.endsWith("/cancel")) {
      if(intent.status==="succeeded") return reply({error:{type:"invalid_request_error",message:"Already captured"}},400);
      intent.status="canceled";
    }
    return reply(intent);
  }
  if(path==="/v1/refunds" && req.method==="POST") {
    const id=`re_fixture${++next}`;
    const paymentId=body.get("payment_intent"), failed=failNextRefund.delete(paymentId);
    refundDispatches.push({paymentId,idempotencyKey:key,executionId:body.get("metadata[refund_execution_id]")});
    const refund={id,object:"refund",payment_intent:body.get("payment_intent"),amount:Number(body.get("amount")),
      currency:"ron",status:failed?"failed":"succeeded",metadata:{payment_refund_id:body.get("metadata[payment_refund_id]"),refund_execution_id:body.get("metadata[refund_execution_id]")}};
    refunds.set(id,refund); if(key) requests.set(key,refund); return reply(refund);
  }
  if(path==="/v1/refunds") return reply({object:"list",data:[...refunds.values()],has_more:false,url:"/v1/refunds"});
  if(path.startsWith("/v1/refunds/")) return reply(refunds.get(path.split("/")[3]) ?? {},refunds.has(path.split("/")[3])?200:404);
  reply({error:{type:"invalid_request_error",message:"Unsupported fixture request"}},404);
});
server.listen(3111,"127.0.0.1");
