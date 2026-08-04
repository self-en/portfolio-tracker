const fs=require("node:fs"),path=require("node:path");
const yf=new (require("yahoo-finance2").default)({versionCheck:false,validation:{logErrors:false,allowAdditionalProps:true},logger:{info(){},warn(){},error(){},debug(){},dir(){}}});
const save=(r,d)=>{const p=path.join("test/fixtures",r);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n");console.error("saved",r);};
(async()=>{
  // AAPL: has dividends AND a 4:1 split (2020-08-31) -> the split double-count test case
  const c=await yf.chart("AAPL",{period1:"2020-06-01",period2:"2021-03-01",interval:"1d",events:"div|split",return:"array"});
  console.error("events keys:",JSON.stringify(Object.keys(c.events||{})));
  console.error("events:",JSON.stringify(c.events).slice(0,600));
  console.error("meta:",JSON.stringify(Object.keys(c.meta)));
  console.error("bar0:",JSON.stringify(c.quotes[0]));
  save("yahoo/chart-AAPL-splitdiv.json",c);
  // quoteCombine batching
  const rs=await Promise.all(["AAPL","MSFT","EUNL.DE"].map(s=>yf.quoteCombine(s)));
  console.error("quoteCombine:",rs.map(r=>`${r.symbol}=${r.regularMarketPrice}${r.currency}`).join(" "));
  save("yahoo/quoteCombine-multi.json",rs);
  const qs=await yf.quoteSummary("AAPL",{modules:["calendarEvents","summaryDetail"]});
  console.error("AAPL quoteSummary modules:",Object.keys(qs));
  console.error("calendarEvents:",JSON.stringify(qs.calendarEvents).slice(0,400));
  save("yahoo/quoteSummary-AAPL.json",qs);
})().catch(e=>{console.error("ERR",e.name,e.message);if(e.result)console.error("has err.result ✓");});
