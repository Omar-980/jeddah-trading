"""The Meta Pixel gets product ID numbers and prices — never product names, button text or
page details — and Render's own *.onrender.com address sends page visits to the real shop.
Meta flagged names like "The Holy Quran" as religious data; this keeps them from being sent."""
import os as _os, pathlib as _pl
# Portable paths: run from anywhere, against the repository this file sits in.
REPO = _os.environ.get("JT_REPO") or str(_pl.Path(__file__).resolve().parents[1])
SHOT = str(_pl.Path(__file__).resolve().parent / "_out"); _os.makedirs(SHOT, exist_ok=True)
CHROME = _os.environ.get("PW_CHROMIUM") or None   # None = Playwright's own browser
import os, json, time, tempfile, subprocess, urllib.request, http.client
from playwright.sync_api import sync_playwright
PORT = 4613
BASE=f"http://127.0.0.1:{PORT}"; DATA=tempfile.mkdtemp(prefix="jt_pixel_")
PIXEL="123456789012345"
subprocess.run(["pkill","-9","-f","[n]ode server.js"],capture_output=True); time.sleep(1)
srv=subprocess.Popen(["node","server.js"],cwd=REPO,env=dict(os.environ,DATA_DIR=DATA,PORT=str(PORT)),
                     stdout=subprocess.PIPE,stderr=subprocess.STDOUT); time.sleep(4)
def api(p,b=None,t=None,m=None):
    data=json.dumps(b).encode() if b is not None else None
    r=urllib.request.Request(BASE+p,data=data,headers={"Content-Type":"application/json",
        **({"Authorization":"Bearer "+t} if t else {})},method=m or ("POST" if data is not None else "GET"))
    return json.loads(urllib.request.urlopen(r).read())
def raw(method,path,host,body=None):
    c=http.client.HTTPConnection("127.0.0.1",PORT,timeout=10)
    c.request(method,path,body=body,headers={"Host":host,"Content-Type":"application/json"})
    r=c.getresponse(); r.read(); return r.status, r.getheader("Location")
fails=[]
def chk(l,ok,x=""):
    print(("  PASS  " if ok else "  FAIL  ")+l+(("  → "+str(x)) if x else ""))
    if not ok: fails.append(l)
try:
    tok=api("/api/admin/login",{"username":"owner","password":"jeddah2026"})["token"]
    api("/api/admin/settings",{"meta_pixel_id":PIXEL},tok)
    pid=api("/api/admin/products",{"name_en":"The Holy Quran","cat":"islamic","price":650,"cost":400,
        "stock":20,"is_active":1},tok)["id"]

    # --- the Pixel: calls are held in its queue because Meta's script is stubbed out here
    with sync_playwright() as pw:
        br=pw.chromium.launch(**({'executable_path': CHROME} if CHROME else {}))
        ctx=br.new_context(viewport={"width":390,"height":860})
        ctx.route("https://connect.facebook.net/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body="/* stub */"))
        ctx.route("https://www.facebook.com/**", lambda r: r.fulfill(status=204, body=""))
        pg=ctx.new_page(); errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(BASE,wait_until="networkidle"); pg.wait_for_timeout(1200)
        pg.evaluate(f"location.hash='product={pid}'"); pg.wait_for_timeout(800)
        pg.evaluate(f"addToCart({pid},1,0)"); pg.wait_for_timeout(300)
        calls=pg.evaluate("(window.fbq&&window.fbq.queue||[]).map(a=>JSON.parse(JSON.stringify([...a])))")
        names=[c[0]+":"+(c[1] if len(c)>1 else "") for c in calls]
        chk("the Pixel loads with the shop's ID", ["init",PIXEL] in [c[:2] for c in calls], names)
        chk("automatic reading of buttons and page details is off, before init",
            names.index("set:autoConfig")<names.index("init:"+PIXEL) and ["set","autoConfig",False,PIXEL] in calls, names)
        ev={c[1]:c[2] for c in calls if c[0]=="track" and len(c)>2}
        chk("viewing a product is reported", "ViewContent" in ev, ev.get("ViewContent"))
        chk("adding to cart is reported", "AddToCart" in ev, ev.get("AddToCart"))
        chk("by ID number", ev.get("AddToCart",{}).get("content_ids")==[f"jt-{pid}"])
        blob=json.dumps(calls)
        chk("no product name ever reaches Meta", "Quran" not in blob and "content_name" not in json.dumps(ev), blob[:200])
        chk("no JavaScript errors", not errs, errs[:3])
        br.close()

    # --- one address: onrender page visits move to the shop, nothing else does
    s,loc=raw("GET","/","jeddah-trading.onrender.com")
    chk("the onrender address sends the shop page to shopjeddahtrading.com", s==301 and loc=="https://shopjeddahtrading.com/", (s,loc))
    s,loc=raw("GET",f"/p/{pid}?size=2","jeddah-trading.onrender.com")
    chk("…keeping the page and its details", loc==f"https://shopjeddahtrading.com/p/{pid}?size=2", loc)
    s,_=raw("GET","/api/products","jeddah-trading.onrender.com")
    chk("the API still answers on the onrender address", s==200, s)
    s,_=raw("POST","/api/webhooks/modempay","jeddah-trading.onrender.com",body=b"{}")
    chk("a payment webhook posted there is not redirected", s!=301, s)
    s,_=raw("GET","/","shopjeddahtrading.com")
    chk("the real address serves the shop", s==200, s)
    s,_=raw("GET","/",f"127.0.0.1:{PORT}")
    chk("a local run is left alone", s==200, s)
finally:
    srv.kill()
print("\nALL PASS" if not fails else f"\n{len(fails)} FAILED: {fails}")
raise SystemExit(1 if fails else 0)
