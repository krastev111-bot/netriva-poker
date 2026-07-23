const { io } = require("socket.io-client");
const crypto = require("crypto");
const URL = "http://localhost:3000";
let lastState=null, kicking=false, histLen=0;

function maybeAct(s, sock, mySeat){
  if(mySeat>=0 && s.acting===mySeat && !s.handOver){
    const me=s.seats[mySeat]; const toCall=s.currentBet-me.bet; const r=Math.random();
    setTimeout(()=>{
      if(r<0.15&&toCall>0)sock.emit("action",{type:"fold"});
      else if(r<0.85)sock.emit("action",{type:"check_call"});
      else sock.emit("action",{type:"raise",target:s.currentBet+s.minRaise});
    },25);
  }
}
const host = io(URL);
let seat=-1;
host.on("seated",d=>seat=d.seat);
host.on("state",s=>{
  lastState=s;
  maybeAct(s,host,seat);
  if(s.handOver && histLen<6 && !kicking){kicking=true;setTimeout(()=>{kicking=false;host.emit("newHand");},250);}
});
host.on("history",h=>{
  histLen=h.length;
  console.log("завършени ръце:",histLen);
  if(histLen>=6){
    const ok=h.every(x=>crypto.createHash("sha256").update(Buffer.from(x.server,"hex")).digest("hex")===x.commit);
    const rats=h.flatMap(x=>x.actions).filter(a=>/\(.+\)/.test(a));
    const total=lastState.seats.filter(p=>p.type!=="empty").reduce((a,p)=>a+p.chips+(p.bet||0),0)+lastState.pot;
    console.log("SHA-256(server)==commit:",ok?"OK":"FAIL");
    console.log("Рационал примери:",rats.slice(0,3).join(" | ")||"НЯМА");
    console.log("Сума чипове на масата:",total);
    console.log("Играчи:",lastState.seats.filter(p=>p.type!=="empty").map(p=>p.type+":"+p.name).join(", "));
    process.exit(ok&&rats.length?0:1);
  }
});
host.emit("create",{name:"Георги",clientSeed:"seed1"},res=>{
  if(res.error){console.error(res.error);process.exit(1);}
  console.log("Стая:",res.code);
  host.emit("settings",{botSpeed:350});
  const g=io(URL); let gs=-1;
  g.on("seated",d=>gs=d.seat);
  g.on("state",s=>maybeAct(s,g,gs));
  g.emit("join",{code:res.code,name:"Мария",clientSeed:""},r=>{if(r.error){console.error(r.error);process.exit(1);}});
});
setTimeout(()=>{console.error("TIMEOUT; последно:",lastState&&{stage:lastState.stage,acting:lastState.acting,handOver:lastState.handOver});process.exit(1);},50000);
