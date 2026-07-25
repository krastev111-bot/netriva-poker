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
app.use(express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

/* ============ КАРТИ / ОЦЕНКА (пренесено 1:1) ============ */
const RANKS = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
const SUITS = ["♠","♥","♦","♣"];
const HAND_NAMES = ["Висока карта","Чифт","Два чифта","Тройка","Кента","Флъш","Фул хаус","Каре","Кента флъш"];
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
  return {v,cat};
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

function makeRoom(code){
  const room={
    code, hostId:null,
    settings:{sb:10,startStack:2000,botSpeed:800,fillBots:"full",autoDeal:true},
    seats:Array.from({length:8},(_,i)=>emptySeat(i)),
    button:7,handNo:0,
    deck:null,deckPos:0,board:[],stage:"idle",
    currentBet:0,minRaise:20,pot:0,acting:-1,handOver:true,
    fair:null,actionLog:[],handHistory:[],lastWin:"—",
    botTimer:null,humanTimer:null,autoTimer:null,nextHandAt:0,deadline:0,pending:[],
    log(msg,cls){io.to(code).emit("log",{msg,cls});},
    rec(txt){room.actionLog.push(txt);}
  };
  rooms.set(code,room);
  return room;
}
function emptySeat(i){
  return {seat:i,type:"empty",id:null,name:"",clientSeed:"",chips:0,
    hole:[],folded:true,allIn:false,bet:0,contrib:0,acted:false,
    showCards:false,winCards:false,handName:"",canRaiseFlag:true,equity:null,
    st:{hands:0,vpip:0,pfr:0,won:0,sdW:0,sdL:0,net:0,_vp:false,_pf:false,_startChips:0},
    pendingReason:""};
}
const SB=r=>r.settings.sb, BB=r=>r.settings.sb*2;
const active=r=>r.seats.filter(p=>p.type!=="empty");
const alive=r=>active(r).filter(p=>!p.folded);
const canAct=r=>alive(r).filter(p=>!p.allIn);
const nextIdx=(r,i)=>{let j=i;do{j=(j+1)%8;}while(r.seats[j].type==="empty");return j;};

function fillBots(room){
  if(!room.settings.fillBots)return;
  const used=new Set(active(room).map(p=>p.name));
  const humans=active(room).filter(p=>p.type==="human").length;
  let want=Math.max(0, (humans>=2?0:2) ); // поне 2 бота ако има само 1 човек
  // цел: масата да има минимум 3 участника; ботове допълват до 8 само ако е включено "пълна маса"
  let need=Math.max(3-active(room).length, want - active(room).filter(p=>p.type==="bot").length);
  if(room.settings.fillBots==="full") need=8-active(room).length;
  for(let i=0;i<8&&need>0;i++){
    if(room.seats[i].type==="empty"){
      const name=BOT_NAMES.find(n=>!used.has(n))||("Бот "+(i+1));
      used.add(name);
      const s=emptySeat(i);
      s.type="bot"; s.name=name; s.chips=room.settings.startStack;
      s.prof={agg:+(0.35+Math.random()*0.55).toFixed(2),loose:+(0.35+Math.random()*0.45).toFixed(2),bluff:+(0.05+Math.random()*0.08).toFixed(3)};
      s.st._startChips=room.settings.startStack;
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
    commit:room.fair?room.fair.commit:null,
    reveal:(room.fair&&room.handOver)?{server:room.fair.serverSeed,client:room.fair.clientSeed,nonce:room.fair.nonce}:null,
    seats:room.seats.map(p=>({
      seat:p.seat,type:p.type,name:p.name,chips:p.chips,bet:p.bet,
      folded:p.folded,allIn:p.allIn,handName:p.showCards?p.handName:"",
      equity:p.equity,winCards:p.winCards,connected:p.type!=="human"||!!p.id,
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
  const start=room.settings.startStack;
  active(room).forEach(p=>{
    if(p.chips<=0){p.st.net+=p.chips-p.st._startChips;p.st._startChips=start;p.chips=start;room.log(p.name+": rebuy "+start,"sys");}
    Object.assign(p,{hole:[],folded:false,allIn:false,bet:0,contrib:0,acted:false,
      showCards:false,winCards:false,handName:"",canRaiseFlag:true,equity:null,pendingReason:""});
    p.st.hands++;p.st._vp=false;p.st._pf=false;
  });
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

  const sbI=nextIdx(room,room.button), bbI=nextIdx(room,sbI);
  postBlind(room.seats[sbI],SB(room)); postBlind(room.seats[bbI],BB(room));
  room.rec("Дилър: "+room.seats[room.button].name+" · "+room.seats[sbI].name+" SB "+SB(room)+" · "+room.seats[bbI].name+" BB "+BB(room));
  room.rec("— PREFLOP —");
  room.currentBet=BB(room); room.minRaise=BB(room);
  const order=[]; let k=room.button;
  for(let i=0;i<active(room).length;i++){k=nextIdx(room,k);order.push(k);}
  for(let r=0;r<2;r++) for(const idx of order) room.seats[idx].hole.push(room.deck[room.deckPos++]);
  room.stage="preflop";
  active(room).forEach(p=>p.acted=false);
  room.acting=nextIdx(room,bbI);
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
function actFold(room,i){
  clearTimers(room);
  const p=room.seats[i];p.folded=true;p.acted=true;
  room.log(p.name+": fold");room.rec(p.name+": fold"+reasonSuffix(p));
  room.acting=nextIdx(room,i);proceed(room);
}
function actCheckCall(room,i){
  clearTimers(room);
  const p=room.seats[i];
  const toCall=room.currentBet-p.bet;
  if(toCall<=0){room.log(p.name+": check");room.rec(p.name+": check"+reasonSuffix(p));}
  else{
    markVpip(room,p,false);
    const a=Math.min(toCall,p.chips);
    p.chips-=a;p.bet+=a;p.contrib+=a;
    if(p.chips===0)p.allIn=true;
    room.log(p.name+": call "+a+(p.allIn?" (all-in)":""));
    room.rec(p.name+": call "+a+(p.allIn?" · all-in":"")+reasonSuffix(p));
  }
  p.acted=true;room.acting=nextIdx(room,i);proceed(room);
}
function actRaiseTo(room,i,target){
  clearTimers(room);
  const p=room.seats[i];
  const maxTo=p.bet+p.chips;
  target=Math.min(Math.round(target),maxTo);
  const minTo=room.currentBet+room.minRaise;
  if(target<minTo&&target<maxTo)target=minTo;
  markVpip(room,p,true);
  const add=target-p.bet;
  p.chips-=add;p.bet=target;p.contrib+=add;
  if(p.chips===0)p.allIn=true;
  const raiseSize=target-room.currentBet;
  const fullRaise=raiseSize>=room.minRaise;
  room.currentBet=Math.max(room.currentBet,target);
  room.log(p.name+": "+(p.allIn?"all-in ":"raise до ")+target);
  room.rec(p.name+": "+(p.allIn?"all-in ":"raise до ")+target+reasonSuffix(p));
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
  const inBB=v=>((v/bbv)%1===0?(v/bbv).toFixed(0):(v/bbv).toFixed(1));
  let strength,made=-1,drawB=0,lateBonus=false;
  if(room.stage==="preflop"){
    strength=preStr(p.hole);
    const n=active(room).length;
    const lateness=(i-room.button+8)%8;
    if(lateness===0||lateness>=Math.max(2,n-2)){strength+=0.06;lateBonus=true;}
    else if(lateness===3||lateness===4)strength-=0.05;
  }else{
    const res=best7(p.hole.concat(room.board));
    made=res.cat;
    strength=Math.min(1,res.cat/6+(res.cat===0?0.05:0.12));
    if(room.stage==="flop"||room.stage==="turn"){drawB=drawStrength(p.hole,room.board);strength+=drawB;}
  }
  const bluff=rnd<pf.bluff;
  const madeTxt=made>=0?HAND_NAMES[made]:"";
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
          p.pendingReason="рейз от блайнда до "+inBB(t)+" BB — силна ръка";
          actRaiseTo(room,i,t);return;
        }
        p.pendingReason="чек от големия блайнд";actCheckCall(room,i);return;
      }
      if((strength>openTh+0.10)||(strength>openTh&&rnd<0.35+pf.agg*0.5)||bluff){
        const openBB=2+pf.agg*1.3+Math.random()*0.7; // 2.0–4.0 BB според агресията
        const t=Math.min(p.bet+p.chips,Math.max(room.currentBet+room.minRaise,halfBB(openBB*bbv)));
        p.pendingReason=(bluff&&strength<=openTh)?("open-рейз "+inBB(t)+" BB като блъф")
          :("отваря с рейз "+inBB(t)+" BB — "+(strength>0.72?"премиум ръка":"добра начална ръка")+(lateBonus?", късна позиция":""));
        actRaiseTo(room,i,t);return;
      }
      if(strength>openTh-0.08&&rnd<0.75-pf.agg*0.35){p.pendingReason="лимп — спекулативна ръка, гледа евтин флоп";actCheckCall(room,i);return;}
      p.pendingReason="слаба начална ръка";actFold(room,i);return;
    }
    // срещу рейз: 3-бет / 4-бет
    if(toCall>0&&room.currentBet>bbv&&p.chips>toCall){
      if(strength>0.80||(strength>0.66&&rnd<pf.agg*0.55)||(bluff&&rnd<0.5)){
        const t=Math.min(p.bet+p.chips,Math.max(room.currentBet+room.minRaise,halfBB(room.currentBet*(2.2+pf.agg*0.9))));
        p.pendingReason=strength>0.80?("3-бет до "+inBB(t)+" BB — много силна ръка")
          :(strength>0.66?("3-бет до "+inBB(t)+" BB — стойност и натиск"):"3-бет блъф");
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
  if(room.board.length>=3)cont.forEach(p=>{p.handName=HAND_NAMES[best7(p.hole.concat(room.board)).cat];});
  equityCalc(room);
}
function endBettingRound(room){
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
  if(runout){revealAllIn(room);broadcast(room);setTimeout(()=>endBettingRound(room),1100);return;}
  room.acting=nextIdx(room,room.button);proceed(room);
}
function dealBoard(room,n){
  room.deckPos++; // burn
  for(let i=0;i<n;i++)room.board.push(room.deck[room.deckPos++]);
}
function endByFold(room){
  const w=alive(room)[0];
  active(room).forEach(p=>{room.pot+=p.bet;p.bet=0;});
  w.chips+=room.pot;w.st.won++;room.lastWin=w.name;
  room.rec(w.name+" печели "+room.pot+" (останалите fold).");
  io.to(room.code).emit("banner",{html:w.name+" печели "+room.pot});
  room.log(w.name+" печели "+room.pot+" (останалите fold).","win");
  finishHand(room);
}
function showdown(room){
  room.stage="showdown";
  const cont=alive(room);
  cont.forEach(p=>{
    p.showCards=true;
    const res=best7(p.hole.concat(room.board));
    p._score=res.v;p.handName=HAND_NAMES[res.cat];
  });
  const levels=[...new Set(active(room).map(p=>p.contrib).filter(x=>x>0))].sort((a,b)=>a-b);
  let prev=0;const gains={};
  for(const L of levels){
    let potAmt=0;
    active(room).forEach(p=>{potAmt+=Math.max(0,Math.min(p.contrib,L)-prev);});
    const elig=cont.filter(p=>p.contrib>=L);
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
  const winTxt=winners.map(p=>p.name+" ("+p.handName+")").join(", ");
  room.lastWin=winners.map(p=>p.name).join(", ");
  io.to(room.code).emit("banner",{html:"Печели: "+winTxt+"<br><span class='bsub'>"+Object.entries(gains).map(([n,g])=>n+" +"+g).join(" · ")+"</span>"});
  room.rec("SHOWDOWN: "+cont.map(p=>p.name+" "+p.hole.map(cardStr).join("")+" → "+p.handName).join(" | "));
  room.rec("Печели: "+winTxt+" · "+Object.entries(gains).map(([n,g])=>n+" +"+g).join(", "));
  room.log("Печели: "+winTxt,"win");
  room.pot=0;finishHand(room);
}
function scheduleAutoDeal(room){
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
function finishHand(room){
  room.handOver=true;room.acting=-1;room.deadline=0;
  // история + разкриване на seed-а (проверимо от клиента)
  room.handHistory.unshift({
    no:room.handNo,commit:room.fair.commit,server:room.fair.serverSeed,
    client:room.fair.clientSeed,nonce:room.fair.nonce,win:room.lastWin,
    actions:room.actionLog.slice()
  });
  if(room.handHistory.length>40)room.handHistory.length=40;
  io.to(room.code).emit("history",room.handHistory.slice(0,40));
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

  socket.on("create",({name,clientSeed},cb)=>{
    const code=codeOf();
    const room=makeRoom(code);
    room.hostId=socket.id;
    joinRoom(room,name,clientSeed,cb);
  });

  socket.on("join",({code,name,clientSeed},cb)=>{
    code=String(code||"").trim().toUpperCase();
    const room=rooms.get(code);
    if(!room)return cb({error:"Няма стая с код "+code+"."});
    joinRoom(room,name,clientSeed,cb);
  });

  function joinRoom(room,name,clientSeed,cb){
    name=String(name||"").trim().slice(0,14)||"Гост";
    // уникално име
    let base=name,n=2;
    while(active(room).some(p=>p.name===name))name=base+" "+(n++);
    const seatNow=()=>{
      // първо освободи бот-място, ако няма празно
      let idx=room.seats.findIndex(s=>s.type==="empty");
      if(idx<0){idx=room.seats.findIndex(s=>s.type==="bot");if(idx>=0)room.seats[idx]=emptySeat(idx);}
      if(idx<0)return false;
      const s=emptySeat(idx);
      s.type="human";s.id=socket.id;s.name=name;s.clientSeed=String(clientSeed||"").slice(0,64);
      s.chips=room.settings.startStack;s.st._startChips=room.settings.startStack;
      room.seats[idx]=s;
      mySeat=idx;
      socket.emit("seated",{seat:idx,code:room.code,host:room.hostId===socket.id});
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
    if(myRoom.acting!==mySeat)return;
    const p=myRoom.seats[mySeat];
    if(!p||p.id!==socket.id)return;
    if(type==="fold")actFold(myRoom,mySeat);
    else if(type==="check_call")actCheckCall(myRoom,mySeat);
    else if(type==="raise"){
      if(p.canRaiseFlag===false)return;
      actRaiseTo(myRoom,mySeat,+target||0);
    }
  });

  socket.on("settings",(s)=>{
    if(!myRoom||mySeat<0)return;
    const r=myRoom, who=r.seats[mySeat];
    if(!who||who.id!==socket.id)return;
    const by=" · промяна от "+who.name;
    if(s.sb&&[10,25,50].includes(+s.sb)){r.settings.sb=+s.sb;r.log("Блайндове "+r.settings.sb+"/"+r.settings.sb*2+(r.handOver?" приложени":" — от следващата ръка")+by+".","sys");}
    if(s.startStack&&[2000,5000,10000].includes(+s.startStack)){
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
    if(s.fillBots!==undefined){r.settings.fillBots=s.fillBots;r.log((s.fillBots==="full"?"Ботове: пълна маса (8)":s.fillBots?"Ботове: допълват до минимум 3 участника":"Ботове: изключени")+by+".","sys");
      if(r.handOver&&!s.fillBots)r.seats.forEach((p,i)=>{if(p.type==="bot")r.seats[i]=emptySeat(i);});
      if(r.handOver)fillBots(r);
    }
    broadcast(r);
  });

  socket.on("seed",(seedStr)=>{
    if(!myRoom||mySeat<0)return;
    const p=myRoom.seats[mySeat];
    if(p&&p.id===socket.id){p.clientSeed=String(seedStr||"").slice(0,64);socket.emit("log",{msg:"Твоят client seed е записан — влиза от следващата ръка.",cls:"sys"});}
  });

  socket.on("disconnect",()=>{
    if(!myRoom)return;
    const room=myRoom;
    const p=mySeat>=0?room.seats[mySeat]:null;
    if(p&&p.id===socket.id){
      p.id=null;
      room.log(p.name+" се разкачи.","sys");
      if(!room.handOver&&!p.folded&&room.acting===mySeat){
        p.pendingReason="разкачване — авто-fold";actFold(room,mySeat);
      }
      // между ръцете мястото се освобождава веднага; иначе — след ръката
      const free=()=>{if(room.seats[p.seat]&&room.seats[p.seat].name===p.name&&!room.seats[p.seat].id)room.seats[p.seat]=emptySeat(p.seat);broadcast(room);};
      if(room.handOver)free(); else room.pending.push(free);
      if(!active(room).some(q=>q.type==="human"&&q.id)&&room.autoTimer){clearTimeout(room.autoTimer);room.autoTimer=null;room.nextHandAt=0;}
      // домакинството минава към следващия човек
      if(room.hostId===socket.id){
        const nh=active(room).find(q=>q.type==="human"&&q.id);
        room.hostId=nh?nh.id:null;
        if(nh){room.log(nh.name+" е новият домакин.","sys");io.to(nh.id).emit("youAreHost");}
      }
      broadcast(room);
      // празна стая — чистене след 10 мин
      if(!active(room).some(q=>q.type==="human"&&q.id)){
        setTimeout(()=>{
          const r=rooms.get(room.code);
          if(r&&!active(r).some(q=>q.type==="human"&&q.id)){clearTimers(r);rooms.delete(room.code);}
        },10*60*1000);
      }
    }
  });
});

server.listen(PORT,()=>console.log("NETRIVA POKER PRO online · порт "+PORT));
