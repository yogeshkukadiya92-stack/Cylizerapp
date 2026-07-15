import{afterEach,describe,expect,it,vi}from"vitest";
import{ResendEmailProvider}from"../src/resend-email-provider.js";
afterEach(()=>vi.unstubAllGlobals());
describe("ResendEmailProvider",()=>{
it("sends with bearer auth and stable idempotency",async()=>{const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({id:"email-message-123"}),{status:200,headers:{"content-type":"application/json"}}));vi.stubGlobal("fetch",fetcher);await expect(new ResendEmailProvider("re_1234567890abcdef","Callora <reports@example.com>").send({to:"owner@example.com",subject:"Ready",text:"Open reports",metadata:{deliveryId:"delivery-1",event:"export_ready"}})).resolves.toEqual({messageId:"email-message-123"});const request=fetcher.mock.calls[0]![1];expect(request.headers).toMatchObject({authorization:"Bearer re_1234567890abcdef","idempotency-key":"callora/delivery-1"});expect(JSON.parse(request.body)).toMatchObject({from:"Callora <reports@example.com>",to:["owner@example.com"]});});
it("returns sanitized provider errors",async()=>{vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({name:"rate_limit\nretry"}),{status:429})));await expect(new ResendEmailProvider("re_1234567890abcdef","reports@example.com").send({to:"a@example.com",subject:"x",text:"x",metadata:{deliveryId:"d",event:"export_ready"}})).rejects.toThrow("Resend 429: rate_limit retry");});
});
