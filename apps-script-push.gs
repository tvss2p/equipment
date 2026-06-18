/***********************************************************************
 * 備品購入 — 締切プッシュ通知バックエンド（Google Apps Script 単体・自前Web Push）
 *
 * 役割：リクエスト締切の「3日前」と「前日」に、購読中の端末へプッシュ通知を送る。
 * 外部サービス不要。VAPID署名(ES256)・本文暗号(AES-128-GCM)を内蔵。
 *
 * セットアップは PUSH_SETUP.md を参照。
 ***********************************************************************/

/* ====== 設定（ここだけ確認すればOK） ====== */
var PUSH_TOKEN = "bihin-push-7f3a9c2e";          // index.html の PUSH_TOKEN と同じ値
var VAPID_PUBLIC  = "BE3c363LSHZuk8K7EGyhDSXbp2c2z26GQNUN2JgTnVW5XO-0q12RUGGvnQOwcI6eGdGMU85X_HsdVwToLI66wGM";
var VAPID_PRIVATE = "LK053x6YFcg4xyXJLPR6oq3ny_IX6RSpXWUR9-0VkUo";
var VAPID_SUBJECT = "mailto:tvss2p@gmail.com"; // 連絡先（任意のmailto:）

/* ====== Web エンドポイント ====== */
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, subs: getSubs_().length, deadline: getProp_("deadline") || "" }))
    .setMimeType(ContentService.MimeType.JSON);
}
function doPost(e) {
  var out = { ok: false };
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.token !== PUSH_TOKEN) { out.error = "bad token"; }
    else if (body.action === "subscribe") { addSub_(body.sub); if (body.deadline) setProp_("deadline", body.deadline); out.ok = true; }
    else if (body.action === "setdeadline") { setProp_("deadline", body.deadline || ""); if (body.nextBuy) setProp_("nextBuy", body.nextBuy); out.ok = true; }
    else if (body.action === "test") { setProp_("deadline", body.deadline || getProp_("deadline")); out.sent = sendToAll_("テスト通知", "プッシュ通知のテストです。"); out.ok = true; }
    else { out.error = "unknown action"; }
  } catch (err) { out.error = String(err); }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* ====== 購読・設定の保存（ScriptProperties） ====== */
function props_() { return PropertiesService.getScriptProperties(); }
function getProp_(k) { return props_().getProperty(k); }
function setProp_(k, v) { props_().setProperty(k, v); }
function getSubs_() { try { return JSON.parse(getProp_("subs") || "[]"); } catch (e) { return []; } }
function saveSubs_(a) { setProp_("subs", JSON.stringify(a)); }
function addSub_(sub) {
  if (!sub || !sub.endpoint) return;
  var a = getSubs_();
  for (var i = 0; i < a.length; i++) { if (a[i].endpoint === sub.endpoint) { a[i] = sub; saveSubs_(a); return; } }
  a.push(sub); saveSubs_(a);
}
function removeEndpoint_(endpoint) {
  var a = getSubs_(), b = [];
  for (var i = 0; i < a.length; i++) if (a[i].endpoint !== endpoint) b.push(a[i]);
  saveSubs_(b);
}

/* ====== 毎日1回トリガーで実行：締切3日前/前日を判定して送信 ====== */
function sendDeadlineNotifications() {
  var deadline = getProp_("deadline");
  if (!deadline) return;
  var tz = Session.getScriptTimeZone() || "Asia/Tokyo";
  var today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  var d3 = addDays_(deadline, -3), d1 = addDays_(deadline, -1);
  var offset = null;
  if (today === d3) offset = 3; else if (today === d1) offset = 1; else return;
  var sentKey = "sent_" + deadline + "_" + offset;
  if (getProp_(sentKey)) return;                 // 同じ通知は1回だけ
  var title = "リクエスト締切のお知らせ";
  var body = (offset === 3) ? ("買い出しリクエストの締切は " + jpDate_(deadline) + "（3日後）です。") 
                            : ("買い出しリクエストの締切は明日 " + jpDate_(deadline) + " です。");
  var sent = sendToAll_(title, body);
  setProp_(sentKey, String(sent));
}
function addDays_(ymd, n) {
  var p = ymd.split("-"); var dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  dt.setDate(dt.getDate() + n);
  var tz = Session.getScriptTimeZone() || "Asia/Tokyo";
  return Utilities.formatDate(dt, tz, "yyyy-MM-dd");
}
function jpDate_(ymd) { var p = ymd.split("-"); return Number(p[1]) + "月" + Number(p[2]) + "日"; }

function sendToAll_(title, bodyText) {
  var subs = getSubs_(), payload = JSON.stringify({ title: title, body: bodyText, url: "./" });
  var ok = 0;
  for (var i = 0; i < subs.length; i++) {
    try {
      var code = sendOne_(subs[i], payload);
      if (code >= 200 && code < 300) ok++;
      else if (code === 404 || code === 410) removeEndpoint_(subs[i].endpoint); // 失効した購読は削除
    } catch (e) {}
  }
  return ok;
}

/* ====== ここから下は暗号処理（Nodeで検証済み・編集不要） ====== */
function u8ToSigned_(u8){var a=new Array(u8.length);for(var i=0;i<u8.length;i++)a[i]=u8[i]<128?u8[i]:u8[i]-256;return a;}
function signedToU8_(arr){var u=new Uint8Array(arr.length);for(var i=0;i<arr.length;i++)u[i]=arr[i]&0xff;return u;}
function teU8_(s){return signedToU8_(Utilities.newBlob(s).getBytes());}
function b64uEnc_(u8){return Utilities.base64EncodeWebSafe(u8ToSigned_(u8)).replace(/=+$/,"");}
function b64uDec_(s){return signedToU8_(Utilities.base64DecodeWebSafe(s));}
var PRIM_ = {
  sha256: function(u8){ return signedToU8_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, u8ToSigned_(u8))); },
  hmac:   function(k,d){ return signedToU8_(Utilities.computeHmacSha256Signature(u8ToSigned_(d), u8ToSigned_(k))); },
  randomBytes: function(n){ var out=new Uint8Array(n),off=0,ctr=0; while(off<n){ var seed=Utilities.getUuid()+":"+ctr+":"+(new Date().getTime())+":"+Math.random(); var blk=PRIM_.sha256(teU8_(seed)); for(var i=0;i<blk.length&&off<n;i++)out[off++]=blk[i]; ctr++; } return out; }
};

function makeP256_(prim){
  var p=0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
  var a=p-3n;
  var Gx=0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
  var Gy=0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;
  var n=0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  var mod=function(x,m){x%=m;return x<0n?x+m:x;};
  var inv=function(x,m){var lo=mod(x,m),hi=m,a0=1n,b0=0n;while(lo>1n){var q=hi/lo;var t=b0-q*a0;b0=a0;a0=t;t=hi-q*lo;hi=lo;lo=t;}return mod(a0,m);};
  var Z={x:0n,y:0n,z:0n};
  var isInf=function(P){return P.z===0n;};
  function dbl(P){ if(isInf(P))return P; var X1=P.x,Y1=P.y,Z1=P.z;
    var A=mod(X1*X1,p),B=mod(Y1*Y1,p),C=mod(B*B,p);
    var D=mod(2n*(mod((X1+B)*(X1+B),p)-A-C),p);
    var ZZ=mod(Z1*Z1,p);
    var E=mod(3n*A+a*mod(ZZ*ZZ,p),p);
    var F=mod(E*E,p);
    var X3=mod(F-2n*D,p);
    var Y3=mod(E*(D-X3)-8n*C,p);
    var Z3=mod(2n*Y1*Z1,p);
    return {x:X3,y:Y3,z:Z3};
  }
  function add(P,Q){ if(isInf(P))return Q; if(isInf(Q))return P;
    var X1=P.x,Y1=P.y,Z1=P.z,X2=Q.x,Y2=Q.y,Z2=Q.z;
    var Z1Z1=mod(Z1*Z1,p),Z2Z2=mod(Z2*Z2,p);
    var U1=mod(X1*Z2Z2,p),U2=mod(X2*Z1Z1,p);
    var S1=mod(Y1*Z2*Z2Z2,p),S2=mod(Y2*Z1*Z1Z1,p);
    if(U1===U2){ if(S1!==S2) return Z; return dbl(P); }
    var H=mod(U2-U1,p),I=mod(mod(2n*H,p)*mod(2n*H,p),p);
    var J=mod(H*I,p),r=mod(2n*(S2-S1),p),V=mod(U1*I,p);
    var X3=mod(r*r-J-2n*V,p);
    var Y3=mod(r*(V-X3)-2n*S1*J,p);
    var Z3=mod(mod((Z1+Z2)*(Z1+Z2),p)-Z1Z1-Z2Z2,p)*H%p;
    return {x:X3,y:mod(Y3,p),z:mod(Z3,p)};
  }
  function mul(k,P){ var R=Z,N=P; k=mod(k,n); while(k>0n){ if(k&1n)R=add(R,N); N=dbl(N); k>>=1n; } return R; }
  function toAffine(P){ if(isInf(P))return null; var zi=inv(P.z,p),zi2=mod(zi*zi,p); return {x:mod(P.x*zi2,p),y:mod(P.y*mod(zi2*zi,p),p)}; }
  var G={x:Gx,y:Gy,z:1n};
  var b2i=function(u8){var r=0n;for(var i=0;i<u8.length;i++)r=(r<<8n)|BigInt(u8[i]);return r;};
  var i2b=function(x,len){var o=new Uint8Array(len);for(var i=len-1;i>=0;i--){o[i]=Number(x&0xffn);x>>=8n;}return o;};
  var cat=function(){var as=arguments,l=0,i;for(i=0;i<as.length;i++)l+=as[i].length;var o=new Uint8Array(l),off=0;for(i=0;i<as.length;i++){o.set(as[i],off);off+=as[i].length;}return o;};
  return {
    derivePub:function(privU8){var k=b2i(privU8);var A=toAffine(mul(k,G));var out=new Uint8Array(65);out[0]=4;out.set(i2b(A.x,32),1);out.set(i2b(A.y,32),33);return out;},
    ecdh:function(privU8,pubU8){var k=b2i(privU8);var P={x:b2i(pubU8.slice(1,33)),y:b2i(pubU8.slice(33,65)),z:1n};var A=toAffine(mul(k,P));return i2b(A.x,32);},
    sign:function(hashU8,privU8){
      var z=b2i(hashU8)%n,x=b2i(privU8);
      var V=new Uint8Array(32);V.fill(1);var K=new Uint8Array(32);K.fill(0);
      var io=function(v){return i2b(v,32);};
      var xo=io(x),ho=io(z);
      K=prim.hmac(K,cat(V,Uint8Array.of(0),xo,ho));V=prim.hmac(K,V);
      K=prim.hmac(K,cat(V,Uint8Array.of(1),xo,ho));V=prim.hmac(K,V);
      while(true){
        V=prim.hmac(K,V);var k=b2i(V)%n;
        if(k>0n){ var R=toAffine(mul(k,G));var r=mod(R.x,n);
          if(r!==0n){ var s=mod(inv(k,n)*(z+r*x),n);
            if(s!==0n){ var out=new Uint8Array(64);out.set(i2b(r,32),0);out.set(i2b(s,32),32);return out; } } }
        K=prim.hmac(K,cat(V,Uint8Array.of(0)));V=prim.hmac(K,V);
      }
    }
  };
}

/* AES-128-GCM (pure JS) */
var SBOX_=new Uint8Array(256);
(function(){ var p=1,q=1; do{ p=p^(p<<1)^(p&0x80?0x11b:0);p&=0xff; q^=q<<1;q^=q<<2;q^=q<<4;q&=0xff;if(q&0x80)q^=0x09; var xf=q^((q<<1)|(q>>7))^((q<<2)|(q>>6))^((q<<3)|(q>>5))^((q<<4)|(q>>4)); SBOX_[p]=(xf^0x63)&0xff; }while(p!==1); SBOX_[0]=0x63; })();
function xtime_(a){return (a&0x80)?((a<<1)^0x11b)&0xff:(a<<1)&0xff;}
function gmul8_(a,b){var r=0;for(var i=0;i<8;i++){if(b&1)r^=a;var hi=a&0x80;a=(a<<1)&0xff;if(hi)a^=0x1b;b>>=1;}return r&0xff;}
function rcon_(i){var c=1;for(var k=1;k<i;k++)c=xtime_(c);return c;}
function keyExp_(key){var Nk=key.length/4,Nr=Nk+6,w=[],i;for(i=0;i<Nk;i++)w[i]=[key[4*i],key[4*i+1],key[4*i+2],key[4*i+3]];
  for(i=Nk;i<4*(Nr+1);i++){var t=w[i-1].slice();if(i%Nk===0){t=[SBOX_[t[1]],SBOX_[t[2]],SBOX_[t[3]],SBOX_[t[0]]];t[0]^=rcon_(i/Nk);}else if(Nk>6&&i%Nk===4){t=[SBOX_[t[0]],SBOX_[t[1]],SBOX_[t[2]],SBOX_[t[3]]];}w[i]=[w[i-Nk][0]^t[0],w[i-Nk][1]^t[1],w[i-Nk][2]^t[2],w[i-Nk][3]^t[3]];}
  return {w:w,Nr:Nr};}
function encBlock_(inp,ks){var w=ks.w,Nr=ks.Nr,s=[[],[],[],[]],i,r,c,row;
  for(i=0;i<16;i++)s[i%4][(i/4)|0]=inp[i];
  for(c=0;c<4;c++)for(row=0;row<4;row++)s[row][c]^=w[c][row];
  for(r=1;r<Nr;r++){ for(i=0;i<4;i++)for(c=0;c<4;c++)s[i][c]=SBOX_[s[i][c]];
    for(i=1;i<4;i++){row=s[i].slice();for(c=0;c<4;c++)s[i][c]=row[(c+i)%4];}
    for(c=0;c<4;c++){var a0=s[0][c],a1=s[1][c],a2=s[2][c],a3=s[3][c];s[0][c]=gmul8_(a0,2)^gmul8_(a1,3)^a2^a3;s[1][c]=a0^gmul8_(a1,2)^gmul8_(a2,3)^a3;s[2][c]=a0^a1^gmul8_(a2,2)^gmul8_(a3,3);s[3][c]=gmul8_(a0,3)^a1^a2^gmul8_(a3,2);}
    for(c=0;c<4;c++)for(row=0;row<4;row++)s[row][c]^=w[r*4+c][row];
  }
  for(i=0;i<4;i++)for(c=0;c<4;c++)s[i][c]=SBOX_[s[i][c]];
  for(i=1;i<4;i++){row=s[i].slice();for(c=0;c<4;c++)s[i][c]=row[(c+i)%4];}
  for(c=0;c<4;c++)for(row=0;row<4;row++)s[row][c]^=w[Nr*4+c][row];
  var out=new Uint8Array(16);for(i=0;i<16;i++)out[i]=s[i%4][(i/4)|0];return out;}
function gmul128_(X,Y){var Zr=new Uint8Array(16),V=Y.slice(),i,j;for(i=0;i<128;i++){var bit=(X[i>>3]>>(7-(i&7)))&1;if(bit)for(j=0;j<16;j++)Zr[j]^=V[j];var lsb=V[15]&1;for(j=15;j>0;j--)V[j]=((V[j]>>1)|((V[j-1]&1)<<7))&0xff;V[0]=V[0]>>1;if(lsb)V[0]^=0xe1;}return Zr;}
function incr_(ctr){for(var i=15;i>=12;i--){ctr[i]=(ctr[i]+1)&0xff;if(ctr[i])break;}}
function gcmEnc_(key,iv,pt,aad){var ks=keyExp_(key);var H=encBlock_(new Uint8Array(16),ks);
  var J0=new Uint8Array(16);J0.set(iv.slice(0,12));J0[15]=1;
  function ghash(data){var Yv=new Uint8Array(16),i,j;for(i=0;i<data.length;i+=16){var blk=new Uint8Array(16);blk.set(data.slice(i,i+16));for(j=0;j<16;j++)Yv[j]^=blk[j];Yv=gmul128_(Yv,H);}return Yv;}
  var ct=new Uint8Array(pt.length),ctr=J0.slice(),i,j;
  for(i=0;i<pt.length;i+=16){incr_(ctr);var ek=encBlock_(ctr,ks);for(j=0;j<16&&i+j<pt.length;j++)ct[i+j]=pt[i+j]^ek[j];}
  var aadLen=aad?aad.length:0,pad=function(x){return (16-(x%16))%16;};
  var gi=new Uint8Array(aadLen+pad(aadLen)+ct.length+pad(ct.length)+16),off=0;
  if(aad){gi.set(aad,off);off+=aadLen+pad(aadLen);}
  gi.set(ct,off);off+=ct.length+pad(ct.length);
  var lb=new Uint8Array(16),setU64=function(arr,o,v){for(var i=7;i>=0;i--){arr[o+i]=v&0xff;v=Math.floor(v/256);}};
  setU64(lb,0,aadLen*8);setU64(lb,8,ct.length*8);gi.set(lb,off);
  var Sb=ghash(gi),ekJ0=encBlock_(J0,ks),tag=new Uint8Array(16);for(i=0;i<16;i++)tag[i]=Sb[i]^ekJ0[i];
  return {ciphertext:ct,tag:tag};}

/* Web Push 組み立て */
function catU8_(){var as=arguments,l=0,i;for(i=0;i<as.length;i++)l+=as[i].length;var o=new Uint8Array(l),off=0;for(i=0;i<as.length;i++){o.set(as[i],off);off+=as[i].length;}return o;}
function hkdf_(salt,ikm,info,len){var prk=PRIM_.hmac(salt,ikm);var prev=new Uint8Array(0),total=new Uint8Array(0),i=1;while(total.length<len){prev=PRIM_.hmac(prk,catU8_(prev,info,Uint8Array.of(i)));total=catU8_(total,prev);i++;}return total.slice(0,len);}

function sendOne_(sub, payloadStr) {
  var EC = makeP256_(PRIM_);
  var uaPublic = b64uDec_(sub.keys.p256dh);
  var authSecret = b64uDec_(sub.keys.auth);
  var asPriv = PRIM_.randomBytes(32);
  var asPublic = EC.derivePub(asPriv);
  var ecdhSecret = EC.ecdh(asPriv, uaPublic);
  var keyInfo = catU8_(teU8_("WebPush: info"), Uint8Array.of(0), uaPublic, asPublic);
  var ikm = hkdf_(authSecret, ecdhSecret, keyInfo, 32);
  var salt = PRIM_.randomBytes(16);
  var cek = hkdf_(salt, ikm, catU8_(teU8_("Content-Encoding: aes128gcm"), Uint8Array.of(0)), 16);
  var nonce = hkdf_(salt, ikm, catU8_(teU8_("Content-Encoding: nonce"), Uint8Array.of(0)), 12);
  var plain = catU8_(teU8_(payloadStr), Uint8Array.of(2));
  var enc = gcmEnc_(cek, nonce, plain, new Uint8Array(0));
  var rs = new Uint8Array(4); rs[0]=0; rs[1]=0; rs[2]=0x10; rs[3]=0; // 4096
  var header = catU8_(salt, rs, Uint8Array.of(65), asPublic);
  var bodyU8 = catU8_(header, enc.ciphertext, enc.tag);
  // VAPID
  var u = sub.endpoint.split("/"); var aud = u[0] + "//" + u[2];
  var jh = b64uEnc_(teU8_(JSON.stringify({ typ:"JWT", alg:"ES256" })));
  var exp = Math.floor(Date.now()/1000) + 12*3600;
  var jp = b64uEnc_(teU8_(JSON.stringify({ aud:aud, exp:exp, sub:VAPID_SUBJECT })));
  var si = jh + "." + jp;
  var sig = EC.sign(PRIM_.sha256(teU8_(si)), b64uDec_(VAPID_PRIVATE));
  var jwt = si + "." + b64uEnc_(sig);
  var resp = UrlFetchApp.fetch(sub.endpoint, {
    method: "post",
    headers: {
      "TTL": "86400",
      "Content-Encoding": "aes128gcm",
      "Authorization": "vapid t=" + jwt + ", k=" + VAPID_PUBLIC
    },
    contentType: "application/octet-stream",
    payload: u8ToSigned_(bodyU8),
    muteHttpExceptions: true
  });
  return resp.getResponseCode();
}
