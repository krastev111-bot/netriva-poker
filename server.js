/* NETRIVA POKER PRO — multiplayer сървър (Node.js + Socket.IO)
   Порт на едноиграчовия енджин: HMAC provably-fair тесте, странични потове,
   ботове с рационал. Сървърът е единственият, който вижда тестето. */
"use strict";
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
/* gzip без външна зависимост: index.html пада от ~152 KB на ~43 KB.
   Пакетира се веднъж при старта и се сервира от паметта. */
const zlib=require("zlib");
const GZ=new Map();
function gzipStatic(req,res,next){
  const f=req.path==="/"?"/index.html":req.path;
  if(!/\.(html|js|css|svg|json)$/.test(f))return next();
  if(!/\bgzip\b/.test(req.headers["accept-encoding"]||""))return next();
  const full=path.join(__dirname,"public",f);
  if(!full.startsWith(path.join(__dirname,"public")))return next();
  const send=buf=>{
    res.setHeader("Content-Encoding","gzip");
    res.setHeader("Vary","Accept-Encoding");
    res.type(path.extname(f)||"html");
    res.setHeader("Cache-Control","no-cache");
    res.end(buf);
  };
  const fs=require("fs");
  fs.stat(full,(se,st)=>{
    if(se)return next();
    const key=st.mtimeMs+":"+st.size;
    const hit=GZ.get(f);
    if(hit&&hit.key===key)return send(hit.buf);
    fs.readFile(full,(err,data)=>{
      if(err)return next();
      zlib.gzip(data,{level:8},(e,buf)=>{
        if(e)return next();
        GZ.set(f,{key,buf});send(buf);
      });
    });
  });
}
app.use(gzipStatic);
app.use(express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

/* ============ КАРТИ / ОЦЕНКА (пренесено 1:1) ============ */
const RANKS = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
const SUITS = ["♠","♥","♦","♣"];
const HAND_NAMES = ["Висока карта","Чифт","Два чифта","Тройка","Кента","Флъш","Фул хаус","Каре","Кента флъш"];
const RANKPL = ["двойки","тройки","четворки","петици","шестици","седмици","осмици",
  "деветки","десетки","валета","дами","попове","аса"];
/* пълното име на ръката, а не само видът ѝ */
function handFull(res){
  const t=res.tie||[],R=RANKS,P=RANKPL;
  switch(res.cat){
    case 8:return "Кента флъш до "+R[t[0]];
    case 7:return "Каре "+P[t[0]];
    case 6:return "Фул хаус: "+P[t[0]]+" над "+P[t[1]];
    case 5:return "Флъш до "+R[t[0]];
    case 4:return "Кента до "+R[t[0]];
    case 3:return "Тройка "+P[t[0]];
    case 2:return "Два чифта: "+P[t[0]]+" и "+P[t[1]];
    case 1:return "Чифт "+P[t[0]];
    default:return "Висока карта "+R[t[0]];
  }
}
/* суми в дневника се маркират, за да ги покаже клиентът в BB или в жетони */
const A = v => "\u27ea"+Math.round(v)+"\u27eb";
const cardStr = c => RANKS[c.r] + SUITS[c.s];
function freshDeck(){ const d=[]; for(let s=0;s<4;s++) for(let r=0;r<13;r++) d.push({r,s}); return d; }

function score5(cs){
  const rs = cs.map(c=>c.r).sort((a,b)=>b-a);
  const flush = cs.every(c=>c.s===cs[0].s);
  const counts = {}; rs.forEach(r=>counts[r]=(counts[r]||0)+1);
  const groups = Object.entries(counts).map(([r,n])=>({r:+r,n})).sort((a,b)=>b.n-a.n||b.r-a.r);
  let sh = -1; const uniq = [...new Set(rs)];
  if(uniq.length===5){
    if(uniq[0]-uniq[4]===4) sh=uniq[0];
    else if(uniq[0]===12 && uniq[1]===3 && uniq[1]-uniq[4]===3) sh=3;
  }
  let cat,tie;
  if(flush&&sh>=0){cat=8;tie=[sh];}
  else if(groups[0].n===4){cat=7;tie=[groups[0].r,groups[1].r];}
  else if(groups[0].n===3&&groups[1].n===2){cat=6;tie=[groups[0].r,groups[1].r];}
  else if(flush){cat=5;tie=rs;}
  else if(sh>=0){cat=4;tie=[sh];}
  else if(groups[0].n===3){cat=3;tie=[groups[0].r,groups[1].r,groups[2].r];}
  else if(groups[0].n===2&&groups[1].n===2){cat=2;tie=[groups[0].r,groups[1].r,groups[2].r];}
  else if(groups[0].n===2){cat=1;tie=[groups[0].r,groups[1].r,groups[2].r,groups[3].r];}
  else{cat=0;tie=rs;}
  let v=cat; for(let i=0;i<5;i++) v=v*16+(tie[i]!==undefined?tie[i]+1:0);
  return {v,cat,tie};
}
function best7(cards){
  if(cards.length===5){const s=score5(cards);return{...s,combo:cards.slice()};}
  let best=null;
  (function rec(start,chosen){
    if(chosen.length===5){
      const combo=chosen.map(i=>cards[i]); const s=score5(combo);
      if(!best||s.v>best.v)best={...s,combo}; return;
    }
    for(let i=start;i<=cards.length-(5-chosen.length);i++){chosen.push(i);rec(i+1,chosen);chosen.pop();}
  })(0,[]);
  return best;
}

/* ============ PROVABLY FAIR (Node crypto, синхронно) ============ */
function hmacHex(seedHex,msg){
  return crypto.createHmac("sha256",Buffer.from(seedHex,"hex")).update(msg).digest("hex");
}
function sha256HexOfHex(hex){
  return crypto.createHash("sha256").update(Buffer.from(hex,"hex")).digest("hex");
}
function byteStream(seedHex){
  let counter=0,pool=[]; const seedBytes=Buffer.from(seedHex,"hex");
  return function(){
    if(pool.length===0){
      const buf=Buffer.alloc(seedBytes.length+4);
      seedBytes.copy(buf,0); buf.writeUInt32BE(counter++,seedBytes.length);
      pool=[...crypto.createHash("sha256").update(buf).digest()];
    }
    return pool.shift();
  };
}
function unbiasedIndex(next,n){
  const limit=Math.floor(256/n)*n;
  while(true){const b=next();if(b<limit)return b%n;}
}
function shuffleFromSeeds(serverSeedHex,clientSeed,nonce){
  const combined=hmacHex(serverSeedHex,clientSeed+":"+nonce);
  const deck=freshDeck(); const next=byteStream(combined);
  for(let i=deck.length-1;i>0;i--){
    const j=unbiasedIndex(next,i+1);
    [deck[i],deck[j]]=[deck[j],deck[i]];
  }
  return deck;
}
const randHex=n=>crypto.randomBytes(n).toString("hex");
/* банерът се вмъква като HTML в клиента — имената задължително се екранират */
const esc=t=>String(t==null?"":t).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

/* ============ БОТ-ПОМОЩНИЦИ (пренесени 1:1) ============ */
function preStr(hole){
  const [a,b]=hole; const hi=Math.max(a.r,b.r),lo=Math.min(a.r,b.r);
  let s=hi*1.4+lo*0.5;
  if(a.r===b.r)s+=22; if(a.s===b.s)s+=4; if(hi-lo===1)s+=3;
  return s/44;
}
function drawStrength(hole,board){
  const cards=hole.concat(board); let bonus=0;
  const sc={}; cards.forEach(c=>sc[c.s]=(sc[c.s]||0)+1);
  if(Object.values(sc).some(n=>n===4))bonus+=0.22;
  const rset=new Set(cards.map(c=>c.r));
  if(rset.has(12))rset.add(-1);
  const arr=[...rset].sort((a,b)=>a-b);
  let run=1,maxRun=1;
  for(let k=1;k<arr.length;k++){run=(arr[k]===arr[k-1]+1)?run+1:1;maxRun=Math.max(maxRun,run);}
  if(maxRun>=5){/* готова кента */}
  else if(maxRun===4)bonus+=0.17;
  else{
    let gut=false;
    for(let lo=-1;lo<=8;lo++){let cnt=0;for(let r=lo;r<lo+5;r++)if(rset.has(r))cnt++;if(cnt===4){gut=true;break;}}
    if(gut)bonus+=0.08;
  }
  return Math.min(bonus,0.3);
}

/* ============ СТАИ ============ */
const BOT_NAMES=["Борис","Елена","Мартин","Ралица","Стоян","Деси","Калоян","Ивайло"];
const rooms=new Map(); // code -> room

/* прост token bucket на сокет — 25 събития, пълни се с 12/сек */
const buckets=new Map();
function rateOk(socket,cost){
  cost=cost||1;
  const now=Date.now();
  let b=buckets.get(socket.id);
  if(!b){b={t:now,v:25};buckets.set(socket.id,b);}
  b.v=Math.min(25,b.v+(now-b.t)*0.012);b.t=now;
  if(b.v<cost)return false;
  b.v-=cost;return true;
}

function makeRoom(code){
  const room={
    code, hostId:null,
    settings:{sb:10,startStack:2000,botSpeed:800,fillBots:"full",autoDeal:true},
    seats:Array.from({length:8},(_,i)=>emptySeat(i)),
    button:7,handNo:0,
    deck:null,deckPos:0,board:[],stage:"idle",
    currentBet:0,minRaise:20,pot:0,acting:-1,handOver:true,
    fair:null,actionLog:[],handHistory:[],lastWin:"—",dealMap:[],lastReveal:null,
    botTimer:null,humanTimer:null,autoTimer:null,nextHandAt:0,deadline:0,pending:[],
    log(msg,cls){io.to(code).emit("log",{msg,cls});},
    act(seat,kind,amt){io.to(code).emit("act",{seat,kind,amt:amt||0});},
    rec(txt){room.actionLog.push(txt);}
  };
  rooms.set(code,room);
  return room;
}
function emptySeat(i){
  return {seat:i,type:"empty",id:null,name:"",clientSeed:"",chips:0,
    hole:[],folded:true,allIn:false,bet:0,contrib:0,acted:false,
    showCards:false,winCards:false,handName:"",canRaiseFlag:true,equity:null,
    st:{hands:0,vpip:0,pfr:0,won:0,sdW:0,sdL:0,net:0,_vp:false,_pf:false,_startChips:0,
        busts:0,entries:1,_entryChips:0,bigPot:0},
    out:false,done:false,wonNow:0,pendingReason:""};
}
const SB=r=>r.settings.sb, BB=r=>r.settings.sb*2;
/* seated = всички на масата (вкл. отпадналите, които чакат решение)
   active = тези, които участват в текущата ръка */
const seated=r=>r.seats.filter(p=>p.type!=="empty");
const active=r=>seated(r).filter(p=>!p.out);
const alive=r=>active(r).filter(p=>!p.folded);
/* стълбица на повторното влизане: 100% → 75% → 60% → 50%, после край на сесията */
const REBUY_PCT=[1,0.75,0.60,0.50];
const MAX_ENTRIES=REBUY_PCT.length;
const MIN_BUYIN_BB=10;   // под това влизането е безсмислено — предлага се нова маса
/* Влизаш с най-малкото от: стъпалото по стълбицата и средния стек на оцелелите.
   Така никога не се появяваш над полето, което е оцеляло без теб. */
function buyinFor(room,p){
  const bb=BB(room), step=Math.min(p.st.busts,MAX_ENTRIES-1);
  const ladder=Math.round(room.settings.startStack*REBUY_PCT[step]/bb)*bb;
  const live=active(room).map(q=>q.chips).filter(c=>c>0).sort((x,y)=>x-y);
  if(!live.length)return ladder;
  /* медиана, не средно: един гигант не бива да те качва над оцелелите,
     нито един микро-стек да ти сваля влизането, когато полето е дълбоко */
  const m=live.length%2?live[(live.length-1)/2]:(live[live.length/2-1]+live[live.length/2])/2;
  const med=Math.round(m/bb)*bb;
  return Math.max(0,Math.min(ladder,med));
}
const canRebuy=(room,p)=>!p.done&&p.st.busts<MAX_ENTRIES&&buyinFor(room,p)>=MIN_BUYIN_BB*BB(room);
const canAct=r=>alive(r).filter(p=>!p.allIn);
/* въртенето на бутона/блайндовете прескача празните места И отпадналите */
const nextIdx=(r,i)=>{let j=i,n=0;do{j=(j+1)%8;n++;}while((r.seats[j].type==="empty"||r.seats[j].out)&&n<=8);return j;};

function fillBots(room){
  if(!room.settings.fillBots)return;
  if(room.started)return;   // турнирът е започнал — фалиралите не се заменят
  const used=new Set(seated(room).map(p=>p.name));
  const humans=seated(room).filter(p=>p.type==="human").length;
  let want=Math.max(0, (humans>=2?0:2) ); // поне 2 бота ако има само 1 човек
  // цел: масата да има минимум 3 участника; ботове допълват до 8 само ако е включено "пълна маса"
  let need=Math.max(3-seated(room).length, want - seated(room).filter(p=>p.type==="bot").length);
  if(room.settings.fillBots==="full") need=8-seated(room).length;
  for(let i=0;i<8&&need>0;i++){
    if(room.seats[i].type==="empty"){
      const name=BOT_NAMES.find(n=>!used.has(n))||("Бот "+(i+1));
      used.add(name);
      const s=emptySeat(i);
      s.type="bot"; s.name=name; s.chips=room.settings.startStack;
      s.prof={agg:+(0.35+Math.random()*0.55).toFixed(2),loose:+(0.35+Math.random()*0.45).toFixed(2),bluff:+(0.05+Math.random()*0.08).toFixed(3)};
      s.st._startChips=room.settings.startStack;s.st._entryChips=room.settings.startStack;
      room.seats[i]=s; need--;
    }
  }
}
function removeBots(room,count){
  for(let i=7;i>=0&&count>0;i--){
    if(room.seats[i].type==="bot"&&(room.handOver||room.seats[i].folded)){
      room.seats[i]=emptySeat(i); count--;
    }
  }
}

/* ============ ИЗПРАЩАНЕ НА СЪСТОЯНИЕ ============ */
function publicState(room){
  return {
    code:room.code, handNo:room.handNo, stage:room.stage, handOver:room.handOver,
    board:room.board, pot:room.pot, currentBet:room.currentBet, minRaise:room.minRaise,
    acting:room.acting, button:room.button, deadline:room.deadline, turnMs:45000, nextHandAt:room.nextHandAt||0,
    settings:room.settings, hostId:room.hostId,
    over:!!room.over, winner:room.winner||"", started:!!room.started,
    entriesMax:MAX_ENTRIES, fieldLeft:active(room).length,
    commit:room.fair?room.fair.commit:null,
    reveal:(room.fair&&room.handOver)?{server:room.fair.serverSeed,client:room.fair.clientSeed,nonce:room.fair.nonce}:null,
    lastReveal:room.lastReveal||null,
    seats:room.seats.map(p=>({
      seat:p.seat,type:p.type,name:p.name,avatar:p.avatar||"",chips:p.chips,bet:p.bet,
      out:!!p.out,done:!!p.done,busts:p.st.busts,wonNow:p.wonNow||0,
      nextBuyin:p.out&&!p.done?buyinFor(room,p):0,place:p.place||0,
      folded:p.folded,allIn:p.allIn,handName:p.showCards?p.handName:"",
      equity:p.equity,winCards:p.winCards,connected:p.type!=="human"||!!p.id,
      net:p.st.net+(p.out?0:(p.chips-p.st._entryChips)),bigPot:p.st.bigPot,entries:p.st.busts+1,
      hole:p.showCards?p.hole:null,
      st:p.st
    }))
  };
}
function broadcast(room){ io.to(room.code).emit("state",publicState(room)); }
function sendHole(room){
  room.seats.forEach(p=>{
    if(p.type==="human"&&p.id) io.to(p.id).emit("hole",{seat:p.seat,hole:p.hole});
  });
}

/* ============ ХОД НА РЪКАТА ============ */
function newHand(room){
  if(room.autoTimer){clearTimeout(room.autoTimer);room.autoTimer=null;}
  room.nextHandAt=0;
  if(room.botTimer){clearTimeout(room.botTimer);room.botTimer=null;}
  if(room.humanTimer){clearTimeout(room.humanTimer);room.humanTimer=null;}
  // чакащи играчи сядат между ръцете
  room.pending.forEach(fn=>fn()); room.pending=[];
  fillBots(room);
  if(active(room).length<2){room.log("Нужни са поне 2 участника.","sys");return;}
  active(room).forEach(p=>{
    p.wonNow=0;
    Object.assign(p,{hole:[],folded:false,allIn:false,bet:0,contrib:0,acted:false,
      showCards:false,winCards:false,handName:"",canRaiseFlag:true,equity:null,pendingReason:"",_shown:false});
    p.st.hands++;p.st._vp=false;p.st._pf=false;
  });
  room.started=true;
  room.board=[];room.pot=0;room.handOver=false;room.actionLog=[];
  room.handNo++;
  room.button=nextIdx(room,room.button);

  // provably fair: commit ПРЕДИ раздаването
  const serverSeed=randHex(32);
  const clientSeed=active(room).map(p=>p.name+":"+(p.clientSeed||"auto-"+p.seat)).join("|");
  const nonce=room.handNo;
  room.fair={serverSeed,clientSeed,nonce,commit:sha256HexOfHex(serverSeed)};
  room.deck=shuffleFromSeeds(serverSeed,clientSeed,nonce);
  room.deckPos=0;

  // хедс-ъп: бутонът е малкият блайнд и действа ПРЪВ префлоп, последен постфлоп
  const heads=active(room).length===2;
  const sbI=heads?room.button:nextIdx(room,room.button), bbI=nextIdx(room,sbI);
  postBlind(room.seats[sbI],SB(room)); postBlind(room.seats[bbI],BB(room));
  room.rec("Дилър: "+room.seats[room.button].name+" · "+room.seats[sbI].name+" SB "+A(SB(room))+" · "+room.seats[bbI].name+" BB "+A(BB(room)));
  room.rec("— PREFLOP —");
  room.currentBet=BB(room); room.minRaise=BB(room);
  const order=[]; let k=room.button;
  for(let i=0;i<active(room).length;i++){k=nextIdx(room,k);order.push(k);}
  room.dealMap=[];
  for(let r=0;r<2;r++) for(const idx of order){
    room.dealMap.push(room.seats[idx].name+" · карта "+(r+1));
    room.seats[idx].hole.push(room.deck[room.deckPos++]);
  }
  room.stage="preflop";
  active(room).forEach(p=>p.acted=false);
  room.acting=heads?sbI:nextIdx(room,bbI);
  room.log("— Ръка №"+room.handNo+". Дилър: "+room.seats[room.button].name+" · печат "+room.fair.commit.slice(0,16)+"… —","sys");
  sendHole(room);
  proceed(room);
}
function postBlind(p,amt){
  const a=Math.min(amt,p.chips);
  p.chips-=a;p.bet=a;p.contrib+=a;
  if(p.chips===0)p.allIn=true;
}
function markVpip(room,p,isRaise){
  if(room.stage!=="preflop")return;
  if(!p.st._vp){p.st._vp=true;p.st.vpip++;}
  if(isRaise&&!p.st._pf){p.st._pf=true;p.st.pfr++;}
}
function reasonSuffix(p){const r=p.pendingReason;p.pendingReason="";return r?" ("+r+")":"";}

function proceed(room){
  broadcast(room);
  if(room.handOver)return;
  if(alive(room).length===0){refundAll(room);return;}
  if(alive(room).length===1){endByFold(room);return;}
  const need=canAct(room).filter(p=>!p.acted||p.bet<room.currentBet);
  if(need.length===0||canAct(room).length===0){endBettingRound(room);return;}
  while(true){
    const p=room.seats[room.acting];
    if(p.type!=="empty"&&!p.folded&&!p.allIn&&(!p.acted||p.bet<room.currentBet))break;
    room.acting=nextIdx(room,room.acting);
  }
  const p=room.seats[room.acting];
  if(p.type==="bot"){
    room.deadline=0;
    broadcast(room);
    const d=room.settings.botSpeed;
    room.botTimer=setTimeout(()=>botAct(room,room.acting),d*0.7+Math.random()*d*0.6);
  }else{
    // човек: 45 секунди, после auto check/fold
    room.deadline=Date.now()+45000;
    broadcast(room);
    const seat=room.acting, hand=room.handNo;
    room.humanTimer=setTimeout(()=>{
      if(room.handNo!==hand||room.acting!==seat||room.handOver)return;
      const q=room.seats[seat];
      if(room.currentBet-q.bet<=0){q.pendingReason="времето изтече — авто-check";actCheckCall(room,seat);}
      else{q.pendingReason="времето изтече — авто-fold";actFold(room,seat);}
    },45000);
  }
}
function clearTimers(room){
  if(room.botTimer){clearTimeout(room.botTimer);room.botTimer=null;}
  if(room.humanTimer){clearTimeout(room.humanTimer);room.humanTimer=null;}
  room.deadline=0;
}
/* пълно изтриване: всички таймери, включително авто-раздаване, рънаут и гратиси */
function destroyRoom(room){
  clearTimers(room);
  if(room.autoTimer){clearTimeout(room.autoTimer);room.autoTimer=null;}
  if(room.runoutTimer){clearTimeout(room.runoutTimer);room.runoutTimer=null;}
  room.seats.forEach(p=>{if(p&&p._grace){clearTimeout(p._grace);p._grace=null;}});
  rooms.delete(room.code);
}
function scheduleCleanup(room){
  if(room.cleanupTimer)clearTimeout(room.cleanupTimer);
  room.cleanupTimer=setTimeout(()=>{
    room.cleanupTimer=null;
    const r=rooms.get(room.code);
    if(r&&!active(r).some(q=>q.type==="human"&&q.id))destroyRoom(r);
  },10*60*1000);
}
function actFold(room,i){
  clearTimers(room);
  const p=room.seats[i];p.folded=true;p.acted=true;
  room.act(i,"fold");
  room.log(p.name+": fold");room.rec(p.name+": fold"+reasonSuffix(p));
  room.acting=nextIdx(room,i);proceed(room);
}
function actCheckCall(room,i){
  clearTimers(room);
  const p=room.seats[i];
  const toCall=room.currentBet-p.bet;
  if(toCall<=0){room.act(i,"check");room.log(p.name+": check");room.rec(p.name+": check"+reasonSuffix(p));}
  else{
    markVpip(room,p,false);
    const a=Math.min(toCall,p.chips);
    p.chips-=a;p.bet+=a;p.contrib+=a;
    if(p.chips===0)p.allIn=true;
    room.act(i,p.allIn?"allin":"call",a);
    room.log(p.name+": call "+A(a)+(p.allIn?" (all-in)":""));
    room.rec(p.name+": call "+A(a)+(p.allIn?" · all-in":"")+reasonSuffix(p));
  }
  p.acted=true;room.acting=nextIdx(room,i);proceed(room);
}
function actRaiseTo(room,i,target){
  clearTimers(room);
  const p=room.seats[i];
  const maxTo=p.bet+p.chips;
  target=Number(target);
  if(!Number.isFinite(target))return;                 // NaN / undefined
  target=Math.round(target);
  const minTo=room.currentBet+room.minRaise;
  if(target<minTo)target=Math.min(minTo,maxTo);       // мин.рейз, но никога над стека
  target=Math.max(p.bet,Math.min(target,maxTo));      // и никога под вече заложеното
  if(target<=p.bet)return;
  markVpip(room,p,true);
  const add=target-p.bet;
  p.chips-=add;p.bet=target;p.contrib+=add;
  if(p.chips===0)p.allIn=true;
  const raiseSize=target-room.currentBet;
  const fullRaise=raiseSize>=room.minRaise;
  room.currentBet=Math.max(room.currentBet,target);
  room.act(i,p.allIn?"allin":"raise",target);
  room.log(p.name+": "+(p.allIn?"all-in ":"raise до ")+A(target));
  room.rec(p.name+": "+(p.allIn?"all-in ":"raise до ")+A(target)+reasonSuffix(p));
  if(fullRaise){
    room.minRaise=raiseSize;
    active(room).forEach(q=>{if(q!==p){q.acted=false;q.canRaiseFlag=true;}});
  }else{
    active(room).forEach(q=>{if(q!==p&&q.acted)q.canRaiseFlag=false;});
    active(room).forEach(q=>{if(q!==p&&q.bet<room.currentBet)q.acted=false;});
  }
  p.acted=true;room.acting=nextIdx(room,i);proceed(room);
}

/* ============ БОТ С РАЦИОНАЛ (пренесен 1:1) ============ */
/* Сила на ръката постфлоп в скала 0–1, съпоставима с префлоп преценката.
   Старият вариант делеше категорията на 6, заради което чифт даваше 0.29,
   а два чифта 0.45 — под прага за залог, тоест ботът чекваше цяла ръка с вале-вале. */
const CAT_STR=[0,0,0.74,0.85,0.92,0.95,0.97,0.99,1.00];
function postStr(res,hole,board){
  // ако най-добрата петица е само от борда — играчът няма нищо свое
  const usesHole=(res.combo||[]).some(c=>hole.some(h=>h.r===c.r&&h.s===c.s));
  if(!usesHole)return 0.28;
  const t=res.tie||[];
  if(res.cat===1){
    const br=board.map(c=>c.r).sort((a,b)=>b-a), pr=t[0];
    if(pr>br[0])return 0.68;                       // овърпеър
    if(pr===br[0]){                                // топ чифт — кикърът тежи
      const k=t[1]!==undefined?t[1]:0;
      return k>=10?0.66:(k>=7?0.60:0.55);
    }
    if(br.length>1&&pr>=br[1])return 0.47;         // среден чифт
    return 0.38;                                   // долен чифт / джобна двойка под борда
  }
  if(res.cat===0){
    const hi=t[0]!==undefined?t[0]:0;
    return hi>=11?0.22:(hi>=9?0.16:0.12);
  }
  return CAT_STR[res.cat];
}
function botAct(room,i){
  room.botTimer=null;
  if(room.handOver||room.acting!==i)return;
  const p=room.seats[i];
  const pf=p.prof||{agg:0.6,loose:0.5,bluff:0.06};
  const toCall=room.currentBet-p.bet;
  const P=room.pot+active(room).reduce((s,q)=>s+q.bet,0);
  const rnd=Math.random();
  const sbv=SB(room), bbv=BB(room);
  const halfBB=v=>Math.max(sbv,Math.round(v/sbv)*sbv); // закръгляне до 0.5 BB
  let strength,made=-1,madeRes=null,drawB=0,lateBonus=false;
  if(room.stage==="preflop"){
    strength=preStr(p.hole);
    const n=active(room).length;
    const lateness=(i-room.button+8)%8;
    if(lateness===0||lateness>=Math.max(2,n-2)){strength+=0.06;lateBonus=true;}
    else if(lateness===3||lateness===4)strength-=0.05;
  }else{
    const res=best7(p.hole.concat(room.board));
    made=res.cat;madeRes=res;
    strength=postStr(res,p.hole,room.board);
    if(room.stage==="flop"||room.stage==="turn"){drawB=drawStrength(p.hole,room.board);strength=Math.min(1,strength+drawB);}
  }
  const bluff=rnd<pf.bluff;
  const madeTxt=madeRes?handFull(madeRes):"";
  const drawTxt=drawB>=0.15?"силно дроу":(drawB>=0.08?"гътшот дроу":"");
  if(p.canRaiseFlag===false&&toCall>0){
    const potOdds=toCall/(P+toCall);
    if(strength>potOdds+0.05){p.pendingReason="плаща къс all-in — цената е малка спрямо пота";actCheckCall(room,i);}
    else{p.pendingReason="слаба ръка дори срещу къс all-in";actFold(room,i);}
    return;
  }
  /* ---------- ПРЕФЛОП ---------- */
  if(room.stage==="preflop"){
    // непокачен пот (само блайндовете)
    if(room.currentBet===bbv){
      const openTh=0.50-pf.loose*0.10;
      if(toCall<=0){ // опция на големия блайнд
        if(strength>0.60&&rnd<0.45+pf.agg*0.4&&p.chips>0){
          const t=Math.min(p.bet+p.chips,Math.max(room.currentBet+room.minRaise,halfBB(bbv*(2.5+pf.agg*1.5))));
          p.pendingReason="рейз от блайнда до "+A(t)+" — силна ръка";
          actRaiseTo(room,i,t);return;
        }
        p.pendingReason="чек от големия блайнд";actCheckCall(room,i);return;
      }
      if((strength>openTh+0.10)||(strength>openTh&&rnd<0.35+pf.agg*0.5)||bluff){
        const openBB=2+pf.agg*1.3+Math.random()*0.7; // 2.0–4.0 BB според агресията
        const t=Math.min(p.bet+p.chips,Math.max(room.currentBet+room.minRaise,halfBB(openBB*bbv)));
        p.pendingReason=(bluff&&strength<=openTh)?("open-рейз "+A(t)+" като блъф")
          :("отваря с рейз "+A(t)+" — "+(strength>0.72?"премиум ръка":"добра начална ръка")+(lateBonus?", късна позиция":""));
        actRaiseTo(room,i,t);return;
      }
      if(strength>openTh-0.08&&rnd<0.75-pf.agg*0.35){p.pendingReason="лимп — спекулативна ръка, гледа евтин флоп";actCheckCall(room,i);return;}
      p.pendingReason="слаба начална ръка";actFold(room,i);return;
    }
    // срещу рейз: 3-бет / 4-бет
    if(toCall>0&&room.currentBet>bbv&&p.chips>toCall){
      if(strength>0.80||(strength>0.66&&rnd<pf.agg*0.55)||(bluff&&rnd<0.5)){
        const t=Math.min(p.bet+p.chips,Math.max(room.currentBet+room.minRaise,halfBB(room.currentBet*(2.2+pf.agg*0.9))));
        p.pendingReason=strength>0.80?("3-бет до "+A(t)+" — много силна ръка")
          :(strength>0.66?("3-бет до "+A(t)+" — стойност и натиск"):"3-бет блъф");
        actRaiseTo(room,i,t);return;
      }
      // иначе продължава към общата кол/фолд преценка по-долу
    }
  }
  /* ---------- ОБЩА ЛОГИКА (пост-флоп + префлоп срещу рейз) ---------- */
  const sizeMult=0.45+Math.random()*0.4;
  if(toCall<=0){
    const betTh=0.50+(1-pf.agg)*0.16;
    if((strength>betTh||bluff)&&p.chips>0&&rnd<0.5+pf.agg*0.45){
      p.pendingReason=(bluff&&strength<=betTh)?"блъф — залага без ръка"
        :("залага за стойност: "+madeTxt+(drawTxt?" + "+drawTxt:""));
      actRaiseTo(room,i,Math.min(p.bet+p.chips,room.currentBet+Math.max(room.minRaise,Math.floor(P*sizeMult))));return;
    }
    if(drawB>=0.15&&rnd<pf.agg*0.5&&p.chips>0){
      p.pendingReason="полу-блъф със силно дроу";
      actRaiseTo(room,i,Math.min(p.bet+p.chips,room.currentBet+Math.max(room.minRaise,Math.floor(P*0.55))));return;
    }
    p.pendingReason=drawTxt?("чек с "+drawTxt+" — чака безплатна карта")
      :(room.stage!=="preflop"&&made<=0?"нищо сглобено — чек":"пасивно, гледа евтино");
    actCheckCall(room,i);return;
  }
  const potOdds=toCall/(P+toCall);
  // защита на силни ръце — ре-рейз за стойност (праг зависи от агресията)
  const valTh=0.60+(1-pf.agg)*0.18;
  if(strength>valTh&&rnd<0.35+pf.agg*0.45&&p.chips>toCall){
    const t=Math.min(p.bet+p.chips,room.currentBet+Math.max(room.minRaise,Math.floor((P+toCall)*(0.6+pf.agg*0.5))));
    p.pendingReason="ре-рейз за стойност"+(madeTxt?" ("+madeTxt+")":"")+" — защитава силната си ръка";
    actRaiseTo(room,i,t);return;
  }
  if(strength>0.85&&p.chips>toCall){
    p.pendingReason="много силна ръка"+(madeTxt?" ("+madeTxt+")":"")+" — вдига за стойност";
    actRaiseTo(room,i,Math.min(p.bet+p.chips,room.currentBet+Math.max(room.minRaise,Math.floor(P*(sizeMult+0.2)))));return;
  }
  if(strength+(bluff?0.3:0)>potOdds+0.14-pf.loose*0.06){
    p.pendingReason=(bluff&&strength<=potOdds)?"блъф-кол"
      :(drawTxt?(drawTxt+" — потът оправдава цената")
      :(made>=1?("плаща с "+madeTxt):"изгодна цена спрямо пота"));
    actCheckCall(room,i);return;
  }
  if(toCall<=bbv&&strength>0.30-pf.loose*0.05){p.pendingReason="евтино доплащане";actCheckCall(room,i);return;}
  p.pendingReason=room.stage==="preflop"?"слаба ръка срещу рейза":"слаба ръка срещу залога";
  actFold(room,i);
}

/* ============ EQUITY / RUNOUT / SHOWDOWN ============ */
function equityCalc(room){
  const cont=alive(room);
  if(cont.length<2)return;
  const known=new Set();
  cont.forEach(p=>p.hole.forEach(c=>known.add(c.r+"-"+c.s)));
  room.board.forEach(c=>known.add(c.r+"-"+c.s));
  const rem=[];
  for(let s=0;s<4;s++)for(let r=0;r<13;r++){if(!known.has(r+"-"+s))rem.push({r,s});}
  const need=5-room.board.length;
  const wins=cont.map(()=>0);let total=0;
  function evalRunout(extra){
    const fb=room.board.concat(extra);
    let bestV=-1,ws=[];
    cont.forEach((p,idx)=>{
      const v=best7(p.hole.concat(fb)).v;
      if(v>bestV){bestV=v;ws=[idx];}
      else if(v===bestV)ws.push(idx);
    });
    ws.forEach(ix=>wins[ix]+=1/ws.length);total++;
  }
  if(need<=0)evalRunout([]);
  else if(need===1){for(const c of rem)evalRunout([c]);}
  else if(need===2){for(let i=0;i<rem.length;i++)for(let j=i+1;j<rem.length;j++)evalRunout([rem[i],rem[j]]);}
  else{
    const N=1500;
    for(let n=0;n<N;n++){
      const idxs=new Set();
      while(idxs.size<need)idxs.add(Math.floor(Math.random()*rem.length));
      evalRunout([...idxs].map(ix=>rem[ix]));
    }
  }
  cont.forEach((p,idx)=>{p.equity=Math.round(100*wins[idx]/total);});
}
function revealAllIn(room){
  const cont=alive(room);
  if(cont.some(p=>!p.showCards)){
    cont.forEach(p=>p.showCards=true);
    const txt=cont.map(p=>p.name+" "+p.hole.map(cardStr).join("")).join(" | ");
    room.log("ALL-IN — картите се обръщат преди рънаута: "+txt,"sys");
    room.rec("ALL-IN: карти открити — "+txt);
  }
  if(room.board.length>=3)cont.forEach(p=>{p.handName=handFull(best7(p.hole.concat(room.board)));});
  equityCalc(room);
}
function endBettingRound(room){
  if(room.handOver)return;               // защита срещу втора верига
  active(room).forEach(p=>{room.pot+=p.bet;p.bet=0;p.acted=false;p.canRaiseFlag=true;});
  room.currentBet=0;room.minRaise=BB(room);
  const runout=canAct(room).length<=1&&alive(room).length>=2;
  if(runout)revealAllIn(room);
  if(room.stage==="preflop"){dealBoard(room,3);room.stage="flop";}
  else if(room.stage==="flop"){dealBoard(room,1);room.stage="turn";}
  else if(room.stage==="turn"){dealBoard(room,1);room.stage="river";}
  else{showdown(room);return;}
  room.log("— "+room.stage.toUpperCase()+": "+room.board.map(cardStr).join(" ")+" —","sys");
  room.rec("— "+room.stage.toUpperCase()+": "+room.board.map(cardStr).join(" ")+" —");
  if(runout){
    revealAllIn(room);
    room.acting=-1;                       // никой не е на ход по време на рънаута
    broadcast(room);
    if(room.runoutTimer)clearTimeout(room.runoutTimer);
    room.runoutTimer=setTimeout(()=>{room.runoutTimer=null;if(!room.handOver)endBettingRound(room);},1100);
    return;
  }
  room.acting=nextIdx(room,room.button);proceed(room);
}
function dealBoard(room,n){
  room.dealMap.push("изгорена карта");
  room.deckPos++; // burn
  for(let i=0;i<n;i++){
    const lbl=n===3?"FLOP":(room.board.length===3?"TURN":"RIVER");
    room.dealMap.push(lbl);
    room.board.push(room.deck[room.deckPos++]);
  }
}
/* всички са напуснали/фолднали — парите се връщат, нищо не изчезва */
function refundAll(room){
  active(room).forEach(p=>{room.pot+=p.bet;p.bet=0;});
  const tot=active(room).reduce((s,p)=>s+p.contrib,0);
  if(tot>0)active(room).forEach(p=>{p.chips+=Math.round(room.pot*p.contrib/tot);});
  room.pot=0;
  room.log("Ръката е прекратена — залозите се връщат.","sys");
  room.rec("Ръката е прекратена — залозите се връщат.");
  room.lastWin="—";
  finishHand(room);
}
function endByFold(room){
  const w=alive(room)[0];
  active(room).forEach(p=>{room.pot+=p.bet;p.bet=0;});
  const amt=room.pot;
  w.chips+=amt;w.st.won++;w.st.bigPot=Math.max(w.st.bigPot,amt);w.wonNow=amt;room.lastWin=w.name;w.winCards=true;
  room.pot=0;
  room.rec(w.name+" печели "+A(amt)+" (останалите fold).");
  io.to(room.code).emit("banner",{html:esc(w.name)+" печели "+A(amt)});
  room.log(w.name+" печели "+A(amt)+" (останалите fold).","win");
  finishHand(room);
}
function showdown(room){
  if(room.handOver)return;               // потът се плаща само веднъж
  room.stage="showdown";
  const cont=alive(room);
  cont.forEach(p=>{
    p.showCards=true;
    const res=best7(p.hole.concat(room.board));
    p._score=res.v;p.handName=handFull(res);
  });
  const levels=[...new Set(active(room).map(p=>p.contrib).filter(x=>x>0))].sort((a,b)=>a-b);
  let prev=0;const gains={};
  for(const L of levels){
    let potAmt=0;
    active(room).forEach(p=>{potAmt+=Math.max(0,Math.min(p.contrib,L)-prev);});
    let elig=cont.filter(p=>p.contrib>=L);
    if(potAmt>0&&elig.length===0){
      // никой жив няма право на това ниво — връща се на най-големия вложител
      const back=active(room).filter(p=>p.contrib>=L).sort((a,b)=>b.contrib-a.contrib)[0];
      if(back){back.chips+=potAmt;gains[back.name]=(gains[back.name]||0)+potAmt;}
      prev=L;continue;
    }
    if(potAmt>0&&elig.length>0){
      const bestV=Math.max(...elig.map(p=>p._score));
      const ws=elig.filter(p=>p._score===bestV);
      const share=Math.floor(potAmt/ws.length);let rem=potAmt-share*ws.length;
      ws.forEach(w=>{const g=share+(rem>0?1:0);if(rem>0)rem--;w.chips+=g;gains[w.name]=(gains[w.name]||0)+g;});
    }
    prev=L;
  }
  const bestV=Math.max(...cont.map(p=>p._score));
  const winners=cont.filter(p=>p._score===bestV);
  winners.forEach(p=>{p.winCards=true;p.st.won++;p.st.sdW++;});
  cont.filter(p=>p._score<bestV).forEach(p=>p.st.sdL++);
  Object.entries(gains).forEach(([n,g])=>{const q=seated(room).find(x=>x.name===n);
    if(q){q.st.bigPot=Math.max(q.st.bigPot,g);q.wonNow=g;}});
  const winTxt=winners.map(p=>esc(p.name)+" ("+esc(p.handName)+")").join(", ");
  room.lastWin=winners.map(p=>p.name).join(", ");
  io.to(room.code).emit("banner",{html:"Печели: "+winTxt+"<br><span class='bsub'>"+Object.entries(gains).map(([n,g])=>esc(n)+" +"+A(g)).join(" · ")+"</span>"});
  room.rec("SHOWDOWN: "+cont.map(p=>p.name+" "+p.hole.map(cardStr).join("")+" → "+p.handName).join(" | "));
  const winPlain=winners.map(p=>p.name+" ("+p.handName+")").join(", ");
  room.rec("Печели: "+winPlain+" · "+Object.entries(gains).map(([n,g])=>n+" +"+A(g)).join(", "));
  room.log("Печели: "+winPlain,"win");
  room.pot=0;finishHand(room);
}
function scheduleAutoDeal(room){
  if(room.over)return;
  if(room.autoTimer){clearTimeout(room.autoTimer);room.autoTimer=null;}
  room.nextHandAt=0;
  const humansOn=()=>active(room).some(p=>p.type==="human"&&p.id);
  if(!room.settings.autoDeal||!humansOn())return;
  const DELAY=5000;
  room.nextHandAt=Date.now()+DELAY;
  room.autoTimer=setTimeout(()=>{
    room.autoTimer=null;room.nextHandAt=0;
    if(!room.handOver||!room.settings.autoDeal||!humansOn())return;
    room.log("Автоматично раздаване на нова ръка.","sys");
    newHand(room);
  },DELAY);
}
/* След всяка ръка: сваляме наказанието на съвзелите се, отбелязваме отпадналите,
   разсаждаме ботовете, които са надули стека си над тавана. */
function settleSeats(room){
  room.seats.forEach((p,i)=>{
    if(p.type==="empty"||p.out)return;
    // наказанието се сваля при удвояване на стека, с който си влязъл
    if(p.st.busts>0&&p.st._entryChips>0&&p.chips>=2*p.st._entryChips){
      p.st.busts=0;
      room.log(p.name+": наказанието е свалено — стекът е удвоен.","sys");
    }
    if(p.chips>0)return;
    // фалит
    p.out=true; p.folded=true; p.allIn=false;
    p.st.net+=-p.st._entryChips;
    p.st.busts++;
    p.place=aliveCount(room)+1;
    if(p.type==="bot"){
      room.log(p.name+" отпада — "+p.place+"-то място.","sys");
      room.seats[i]=emptySeat(i);
      return;
    }
    if(!canRebuy(room,p)){
      p.done=true;
      room.log(p.name+": сесията свърши · "+p.st.busts+" от "+MAX_ENTRIES+" влизания · "+p.place+"-то място.","sys");
    } else {
      room.log(p.name+" отпадна. Следващо влизане: "+A(buyinFor(room,p))+" ("+p.place+"-то място, ако спреш дотук)","sys");
    }
  });
  // турнирът свършва, когато остане един
  const left=active(room);
  if(!room.over&&room.started&&left.length===1){
    room.over=true; room.winner=left[0].name; left[0].place=1;
    room.log("★ "+left[0].name+" печели турнира със "+A(left[0].chips)+" ★","win");
    io.to(room.code).emit("banner",{html:"★ "+esc(left[0].name)+" печели турнира ★"});
  }
}
const aliveCount=r=>active(r).length;
function finishHand(room){
  room.handOver=true;room.acting=-1;room.deadline=0;
  // история + разкриване на seed-а (проверимо от клиента)
  room.lastReveal={no:room.handNo,server:room.fair.serverSeed,client:room.fair.clientSeed,nonce:room.fair.nonce,commit:room.fair.commit};
  room.handHistory.unshift({
    no:room.handNo,commit:room.fair.commit,server:room.fair.serverSeed,
    client:room.fair.clientSeed,nonce:room.fair.nonce,win:room.lastWin,
    actions:room.actionLog.slice(),
    deck:room.deck?room.deck.map(cardStr):[],used:room.deckPos,map:room.dealMap.slice()
  });
  if(room.handHistory.length>40)room.handHistory.length=40;
  io.to(room.code).emit("history",room.handHistory.slice(0,40));
  settleSeats(room);
  scheduleAutoDeal(room);
  broadcast(room);
}

/* ============ SOCKET.IO ============ */
const codeOf=()=> {
  const abc="ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let c;do{c=Array.from({length:5},()=>abc[Math.floor(Math.random()*abc.length)]).join("");}while(rooms.has(c));
  return c;
};

io.on("connection",socket=>{
  let myRoom=null,mySeat=-1;

  socket.on("create",({name,clientSeed,avatar},cb)=>{
    cb=typeof cb==="function"?cb:()=>{};
    if(!rateOk(socket,5))return cb({error:"Твърде много заявки — изчакай малко."});
    if(myRoom)return cb({error:"Вече си на маса."});
    const code=codeOf();
    const room=makeRoom(code);
    room.hostId=socket.id;
    joinRoom(room,name,clientSeed,cb,avatar,null);
  });

  socket.on("join",({code,name,clientSeed,avatar,token},cb)=>{
    cb=typeof cb==="function"?cb:()=>{};
    if(!rateOk(socket,5))return cb({error:"Твърде много заявки — изчакай малко."});
    if(myRoom)return cb({error:"Вече си на маса."});
    code=String(code||"").trim().toUpperCase();
    const room=rooms.get(code);
    if(!room)return cb({error:"Няма стая с код "+code+"."});
    joinRoom(room,name,clientSeed,cb,avatar,token);
  });

  function joinRoom(room,name,clientSeed,cb,avatar,token){
    name=String(name||"").trim().slice(0,14)||"Гост";
    // връщане след прекъсване: същото име → същото място и стек
    // връщане само със собствения токен — иначе всеки може да заеме чуждо място по име
    const back=token?active(room).find(q=>q.type==="human"&&!q.id&&q.tok&&q.tok===String(token)):null;
    if(back){
      back.id=socket.id;
      if(clientSeed)back.clientSeed=String(clientSeed).slice(0,64);
      if(avatar)back.avatar=String(avatar).slice(0,4);
      if(back._grace){clearTimeout(back._grace);back._grace=null;}
      myRoom=room;mySeat=back.seat;
      socket.join(room.code);
      if(!room.hostId)room.hostId=socket.id;
      socket.emit("seated",{seat:back.seat,code:room.code,host:room.hostId===socket.id,token:back.tok});
      room.log(name+" се върна на мястото си.","sys");
      if(!room.handOver&&back.hole&&back.hole.length&&!back.folded)
        io.to(back.id).emit("hole",{seat:back.seat,hole:back.hole});
      cb({ok:true,code:room.code,host:room.hostId===socket.id,rejoined:true});
      socket.emit("history",room.handHistory.slice(0,40));
      broadcast(room);
      return;
    }
    // уникално име
    let base=name,n=2;
    while(active(room).some(p=>p.name===name))name=base+" "+(n++);
    const seatNow=()=>{
      if(!socket.connected)return false;   // разкачил се е, докато е чакал реда си
      // първо освободи бот-място, ако няма празно
      let idx=room.seats.findIndex(s=>s.type==="empty");
      if(idx<0){idx=room.seats.findIndex(s=>s.type==="bot");if(idx>=0)room.seats[idx]=emptySeat(idx);}
      if(idx<0)return false;
      const s=emptySeat(idx);
      s.type="human";s.id=socket.id;s.name=name;s.clientSeed=String(clientSeed||"").slice(0,64);
      s.tok=randHex(12);
      s.chips=room.settings.startStack;s.st._startChips=room.settings.startStack;
      s.st._entryChips=room.settings.startStack;
      s.avatar=String(avatar||"").slice(0,4);
      room.seats[idx]=s;
      mySeat=idx;
      socket.emit("seated",{seat:idx,code:room.code,host:room.hostId===socket.id,token:s.tok});
      room.log(name+" сяда на масата (място "+(idx+1)+").","sys");
      broadcast(room);
      return true;
    };
    myRoom=room;
    socket.join(room.code);
    if(active(room).length>=8&&!room.seats.some(s=>s.type==="bot"))
      return cb({error:"Масата е пълна (8 играчи)."});
    if(room.handOver){ if(!seatNow())return cb({error:"Масата е пълна."}); }
    else{
      room.log(name+" изчаква края на ръката, за да седне.","sys");
      socket.emit("waiting",{code:room.code});
      room.pending.push(seatNow);
    }
    cb({ok:true,code:room.code,host:room.hostId===socket.id});
    socket.emit("state",publicState(room));
    socket.emit("history",room.handHistory.slice(0,40));
  }

  socket.on("newHand",()=>{
    if(!myRoom)return;
    if(mySeat<0||myRoom.seats[mySeat].id!==socket.id)return;
    if(!myRoom.handOver)return;
    myRoom.log(myRoom.seats[mySeat].name+" раздава нова ръка.","sys");
    newHand(myRoom);
  });

  socket.on("action",({type,target})=>{
    if(!myRoom||myRoom.handOver)return;
    if(!rateOk(socket))return;
    if(myRoom.stage==="showdown"||myRoom.acting!==mySeat)return;
    const p=myRoom.seats[mySeat];
    if(!p||p.id!==socket.id)return;
    if(p.folded||p.allIn)return;          // all-in/фолднал не може да действа повече
    if(type==="fold")actFold(myRoom,mySeat);
    else if(type==="check_call")actCheckCall(myRoom,mySeat);
    else if(type==="raise"){
      if(p.canRaiseFlag===false)return;
      actRaiseTo(myRoom,mySeat,target);
    }
  });

  socket.on("settings",(s)=>{
    if(!myRoom||mySeat<0||!s||typeof s!=="object")return;
    if(!rateOk(socket,2))return;
    const r=myRoom, who=r.seats[mySeat];
    if(!who||who.id!==socket.id)return;
    const isHost=r.hostId===socket.id;
    const by=" · промяна от "+who.name;
    if(s.sb&&[10,25,50].includes(+s.sb)){r.settings.sb=+s.sb;r.log("Блайндове "+r.settings.sb+"/"+r.settings.sb*2+(r.handOver?" приложени":" — от следващата ръка")+by+".","sys");}
    if(s.startStack&&isHost&&[2000,5000,10000].includes(+s.startStack)){
      r.settings.startStack=+s.startStack;
      if(r.handOver){active(r).forEach(p=>{p.st.net+=p.chips-p.st._startChips;p.chips=r.settings.startStack;p.st._startChips=r.settings.startStack;});r.log("Стек "+r.settings.startStack+" приложен за всички"+by+".","sys");}
      else r.log("Стек "+r.settings.startStack+" — от следващата ръка"+by+".","sys");
    }
    if(s.botSpeed&&[1400,800,350].includes(+s.botSpeed)){r.settings.botSpeed=+s.botSpeed;r.log("Скорост на ботовете обновена"+by+".","sys");}
    if(s.autoDeal!==undefined){
      r.settings.autoDeal=!!s.autoDeal;
      r.log("Автоматично раздаване: "+(r.settings.autoDeal?"включено":"изключено")+by+".","sys");
      if(r.settings.autoDeal&&r.handOver&&r.handNo>0)scheduleAutoDeal(r);
      if(!r.settings.autoDeal&&r.autoTimer){clearTimeout(r.autoTimer);r.autoTimer=null;r.nextHandAt=0;}
    }
    if(s.fillBots!==undefined&&["full",true,false].includes(s.fillBots)){r.settings.fillBots=s.fillBots;r.log((s.fillBots==="full"?"Ботове: пълна маса (8)":s.fillBots?"Ботове: допълват до минимум 3 участника":"Ботове: изключени")+by+".","sys");
      if(r.handOver&&!s.fillBots)r.seats.forEach((p,i)=>{if(p.type==="bot")r.seats[i]=emptySeat(i);});
      if(r.handOver)fillBots(r);
    }
    broadcast(r);
  });

  socket.on("showCards",()=>{
    if(!myRoom||mySeat<0)return;
    const r=myRoom,p=r.seats[mySeat];
    if(!p||p.id!==socket.id||!r.handOver||!p.hole||!p.hole.length)return;
    if(p._shown)return;
    p._shown=true;p.showCards=true;
    const txt=p.hole.map(cardStr).join(" ");
    r.log(p.name+" показва: "+txt,"sys");
    if(r.handHistory[0])r.handHistory[0].actions.push(p.name+" показва картите си: "+txt);
    io.to(r.code).emit("history",r.handHistory.slice(0,40));
    broadcast(r);
  });

  socket.on("avatar",(a)=>{
    if(!myRoom||mySeat<0)return;
    const p=myRoom.seats[mySeat];
    if(!p||p.id!==socket.id)return;
    p.avatar=String(a||"").slice(0,4);
    broadcast(myRoom);
  });

  socket.on("react",(e)=>{
    if(!myRoom||mySeat<0)return;
    const p=myRoom.seats[mySeat];
    if(!p||p.id!==socket.id)return;
    const now=Date.now();
    if(p._lastReact&&now-p._lastReact<1500)return; // анти-спам
    p._lastReact=now;
    io.to(myRoom.code).emit("react",{seat:mySeat,emoji:String(e||"").slice(0,4)});
  });

  socket.on("seed",(seedStr)=>{
    if(!myRoom||mySeat<0)return;
    const p=myRoom.seats[mySeat];
    if(p&&p.id===socket.id){p.clientSeed=String(seedStr||"").slice(0,64);socket.emit("log",{msg:"Твоят client seed е записан — влиза от следващата ръка.",cls:"sys"});}
  });

  socket.on("rebuy",()=>{
    if(!myRoom||mySeat<0)return;
    if(!rateOk(socket,3))return;
    const room=myRoom,p=room.seats[mySeat];
    if(!p||p.id!==socket.id||p.type!=="human")return;
    if(!p.out||p.done)return;
    if(!canRebuy(room,p))return;
    const amt=buyinFor(room,p);
    p.chips=amt; p.st._startChips=amt; p.st._entryChips=amt;
    p.st.entries=p.st.busts+1;
    p.out=false; p.folded=true; p.bet=0; p.contrib=0; p.hole=[];
    room.log(p.name+" влиза отново с "+A(amt)+(p.st.busts?" ("+(p.st.busts+1)+"-то влизане)":""),"sys");
    broadcast(room);
    if(room.handOver&&room.settings.autoDeal)scheduleAutoDeal(room);
  });

  socket.on("leaveTable",()=>{
    if(!myRoom||mySeat<0)return;
    const room=myRoom,p=room.seats[mySeat];
    if(!p||p.id!==socket.id)return;
    if(p._grace){clearTimeout(p._grace);p._grace=null;}
    room.log(p.name+" напуска масата.","sys");
    const seat=p.seat,nm=p.name;
    const free=()=>{
      const q=room.seats[seat];
      if(q&&q.name===nm)room.seats[seat]=emptySeat(seat);
      broadcast(room);
    };
    if(room.handOver)free();
    else{
      p.id=null;
      // фолдваме през нормалния път, за да не остане залог без наследник
      if(room.acting===seat)actFold(room,seat);
      else{p.folded=true;p.acted=true;}
      room.pending.push(free);
    }
    if(room.hostId===socket.id){
      const nh=active(room).find(q=>q.type==="human"&&q.id);
      room.hostId=nh?nh.id:null;
      if(nh)io.to(nh.id).emit("youAreHost");
    }
    socket.leave(room.code);
    myRoom=null;mySeat=-1;
    broadcast(room);
    if(!active(room).some(q=>q.type==="human"&&q.id)){
      if(room.autoTimer){clearTimeout(room.autoTimer);room.autoTimer=null;room.nextHandAt=0;}
      scheduleCleanup(room);
    }
  });

  socket.on("disconnect",()=>{
    buckets.delete(socket.id);
    if(!myRoom)return;
    const room=myRoom;
    const p=mySeat>=0?room.seats[mySeat]:null;
    if(p&&p.id===socket.id){
      p.id=null;
      room.log(p.name+" се разкачи — мястото се пази 90 секунди за връщане.","sys");
      // НЕ фолдваме веднага: ако му дойде редът, 45-сек. таймер ще реши сам
      const free=()=>{if(room.seats[p.seat]&&room.seats[p.seat].name===p.name&&!room.seats[p.seat].id)room.seats[p.seat]=emptySeat(p.seat);broadcast(room);};
      if(p._grace)clearTimeout(p._grace);
      p._grace=setTimeout(()=>{
        p._grace=null;
        if(p.id)return; // върнал се е навреме
        room.log(p.name+" не се върна — мястото се освобождава.","sys");
        if(room.handOver)free(); else room.pending.push(free);
        broadcast(room);
      },90000);
      if(!active(room).some(q=>q.type==="human"&&q.id)&&room.autoTimer){clearTimeout(room.autoTimer);room.autoTimer=null;room.nextHandAt=0;}
      // домакинството минава към следващия човек
      if(room.hostId===socket.id){
        const nh=active(room).find(q=>q.type==="human"&&q.id);
        room.hostId=nh?nh.id:null;
        if(nh){room.log(nh.name+" е новият домакин.","sys");io.to(nh.id).emit("youAreHost");}
      }
      broadcast(room);
      // празна стая — чистене след 10 мин
      if(!active(room).some(q=>q.type==="human"&&q.id))scheduleCleanup(room);
    }
  });
});

server.listen(PORT,()=>console.log("NETRIVA POKER PRO online · порт "+PORT));