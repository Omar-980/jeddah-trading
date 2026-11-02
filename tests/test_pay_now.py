"""The shopper actually sees Pay now, and only when it is switched on."""
import os as _os, pathlib as _pl
# Portable paths: run from anywhere, against the repository this file sits in.
REPO = _os.environ.get("JT_REPO") or str(_pl.Path(__file__).resolve().parents[1])
SHOT = str(_pl.Path(__file__).resolve().parent / "_out"); _os.makedirs(SHOT, exist_ok=True)
CHROME = _os.environ.get("PW_CHROMIUM") or None   # None = Playwright's own browser
import os, json, time, tempfile, shutil, subprocess, urllib.request
from playwright.sync_api import sync_playwright
PORT = 4597
BASE=f"http://127.0.0.1:{PORT}"; DATA=tempfile.mkdtemp(prefix="jt_pn_")
subprocess.run(["pkill","-9","-f","[n]ode server.js"],capture_output=True); time.sleep(1)
srv=subprocess.Popen(["node","server.js"],cwd=REPO,env=dict(os.environ,DATA_DIR=DATA,PORT=str(PORT)),
                     stdout=subprocess.PIPE,stderr=subprocess.STDOUT); time.sleep(4)
def api(p,b=None,t=None,m=None):
    r=urllib.request.Request(BASE+p,data=json.dumps(b).encode() if b is not None else None,
      headers={"Content-Type":"application/json",**({"Authorization":"Bearer "+t} if t else {})},
      method=m or ("POST" if b is not None else "GET"))
    return json.loads(urllib.request.urlopen(r).read())
fails=[]
def chk(l,ok,x=""):
    print(("  PASS  " if ok else "  FAIL  ")+l+(("  → "+str(x)) if x else ""))
    if not ok: fails.append(l)
try:
    tok=api("/api/admin/login",{"username":"owner","password":"jeddah2026"})["token"]
    pid=api("/api/admin/products",{"name_en":"Ajwa Dates","cat":"herbs","price":400,"cost":200,
        "stock":20,"is_active":1},tok)["id"]
    with sync_playwright() as pw:
        br=pw.chromium.launch(**({'executable_path': CHROME} if CHROME else {}))
        ctx=br.new_context(viewport={"width":390,"height":860}); pg=ctx.new_page(); errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)))
        def to_payment_step():
            pg.goto(BASE,wait_until="networkidle"); pg.wait_for_timeout(1800)
            pg.evaluate(f"addToCart({pid},1,0)"); pg.wait_for_timeout(500)
            pg.evaluate("openCheckout()"); pg.wait_for_timeout(1000)
            pg.fill("#coName","Awa Njie"); pg.fill("#coPhone","2207001122")
            pg.evaluate("coNext()"); pg.wait_for_timeout(700)
            pg.evaluate("document.querySelector('[data-deliv=\\'pickup\\']').click()"); pg.wait_for_timeout(300)
            pg.evaluate("coNext()"); pg.wait_for_timeout(900)
        to_payment_step()
        chk("with no keys entered, Pay now is not offered", pg.locator('[data-pay="online"]').count()==0, "")
        chk("the usual methods are all still there", pg.locator('.pay-opt').count()>=3,
            pg.locator('.pay-opt').count())
        api("/api/admin/settings",{"modempay_enabled":"1","modempay_secret_key":"sk_test_x",
            "modempay_webhook_secret":"whsec_x"},tok)
        to_payment_step()
        chk("once the keys are in, Pay now appears", pg.locator('[data-pay="online"]').count()==1, "")
        txt=pg.inner_text('[data-pay="online"]')
        chk("and names the methods a customer knows",
            "Wave" in txt and "AfriMoney" in txt, repr(txt))
        chk("it sits above the manual methods, not replacing them",
            pg.locator('.pay-opt').count()>=4, pg.locator('.pay-opt').count())
        pg.click('[data-pay="online"]'); pg.wait_for_timeout(400)
        chk("and can be chosen", pg.evaluate("coData.pay")=="online", pg.evaluate("coData.pay"))
        pg.screenshot(path=SHOT+"/paynow.png",full_page=False)
        chk("no JavaScript errors", not errs, errs[:2])
        st=pg.goto(f"{BASE}/payment/done?ref=JT-TEST"); pg.wait_for_timeout(1200)
        chk("the page they come back to opens", st.status==200 and "payment" in pg.inner_text("body").lower(),
            pg.inner_text("body")[:60])
        br.close()
finally:
    srv.terminate()
    try: srv.wait(timeout=5)
    except Exception: srv.kill()
    shutil.rmtree(DATA,ignore_errors=True)
print()
print("PAYNOW_FAIL — "+"; ".join(fails) if fails else "PAYNOW_PASS — Pay now shows only when it is ready, beside the old methods")
