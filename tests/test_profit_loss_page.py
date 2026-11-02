"""The admin's Profit & Loss page renders the new lines."""
import os as _os, pathlib as _pl
# Portable paths: run from anywhere, against the repository this file sits in.
REPO = _os.environ.get("JT_REPO") or str(_pl.Path(__file__).resolve().parents[1])
SHOT = str(_pl.Path(__file__).resolve().parent / "_out"); _os.makedirs(SHOT, exist_ok=True)
CHROME = _os.environ.get("PW_CHROMIUM") or None   # None = Playwright's own browser
import os, json, time, tempfile, shutil, subprocess, urllib.request
from playwright.sync_api import sync_playwright
PORT = 4571
BASE=f"http://127.0.0.1:{PORT}"; DATA=tempfile.mkdtemp(prefix="jt_pl_")
subprocess.run(["pkill","-9","-f","[n]ode server.js"],capture_output=True); time.sleep(1)
srv=subprocess.Popen(["node","server.js"],cwd=REPO,env=dict(os.environ,DATA_DIR=DATA,PORT=str(PORT)),
                     stdout=subprocess.PIPE,stderr=subprocess.STDOUT); time.sleep(4)
def api(p,b=None,t=None,m=None):
    r=urllib.request.Request(BASE+p,data=json.dumps(b).encode() if b is not None else None,
      headers={"Content-Type":"application/json",**({"Authorization":"Bearer "+t} if t else {})},
      method=m or ("POST" if b is not None else "GET"))
    try: return json.loads(urllib.request.urlopen(r).read())
    except urllib.error.HTTPError as e:
        d=json.loads(e.read()); print("  (HTTP",e.code,"on",p,"→",d,")"); return d
fails=[]
def chk(l,ok,x=""):
    print(("  PASS  " if ok else "  FAIL  ")+l+(("  → "+str(x)) if x else ""))
    if not ok: fails.append(l)
try:
    tok=api("/api/admin/login",{"username":"owner","password":"jeddah2026"})["token"]
    z=api("/api/admin/zones",{"name":"Serrekunda","fee":150},tok)
    zid=z.get("id") or (z.get("zone") or {}).get("id")
    api("/api/admin/settings",{"free_delivery_over":"99999"},tok)
    pid=api("/api/admin/products",{"name_en":"Ajwa Dates","cat":"herbs","price":400,"cost":200,
        "stock":20,"is_active":1},tok)["id"]
    api("/api/orders",{"customer_name":"Awa","customer_phone":"2207001122","delivery_method":"home",
        "delivery_zone_id":zid,"delivery_address":"Latrikunda","items":[{"id":pid,"qty":1}]})
    with sync_playwright() as pw:
        br=pw.chromium.launch(**({'executable_path': CHROME} if CHROME else {}))
        pg=br.new_page(viewport={"width":1280,"height":900}); errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(f"{BASE}/admin",wait_until="networkidle")
        pg.fill("#user","owner"); pg.fill("#pw","jeddah2026"); pg.press("#pw","Enter")
        pg.wait_for_selector(".navbtn[data-view='reports']",timeout=20000)
        pg.click(".navbtn[data-view='reports']"); pg.wait_for_timeout(1500)
        pg.select_option("#repType","pl"); pg.wait_for_timeout(2000)
        txt=pg.inner_text("#repCards") if pg.locator("#repCards").count() else pg.inner_text("#view-reports")
        for want in ("Goods sold","Delivery charged","Total takings","Gross profit","Net profit"):
            chk(f"the P&L shows {want}", want.lower() in txt.lower(), "")
        chk("with the delivery money on its own line", "D150" in txt, txt[:200].replace("\n"," | "))
        chk("and the goods beside it", "D400" in txt, "")
        chk("no JavaScript errors", not errs, errs[:2])
        pg.screenshot(path=SHOT+"/pl_cards.png",full_page=False)
        br.close()
finally:
    srv.terminate()
    try: srv.wait(timeout=5)
    except Exception: srv.kill()
    shutil.rmtree(DATA,ignore_errors=True)
print()
print("PL_FAIL — "+"; ".join(fails) if fails else "PL_PASS — the delivery money is visible on its own line")
