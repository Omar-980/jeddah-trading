"""Switching a payment method off hides it, and the checkout is never left with no way to pay."""
import os as _os, pathlib as _pl
# Portable paths: run from anywhere, against the repository this file sits in.
REPO = _os.environ.get("JT_REPO") or str(_pl.Path(__file__).resolve().parents[1])
SHOT = str(_pl.Path(__file__).resolve().parent / "_out"); _os.makedirs(SHOT, exist_ok=True)
CHROME = _os.environ.get("PW_CHROMIUM") or None   # None = Playwright's own browser
import os, json, time, tempfile, shutil, subprocess, urllib.request
from playwright.sync_api import sync_playwright
PORT = 4598
BASE=f"http://127.0.0.1:{PORT}"; DATA=tempfile.mkdtemp(prefix="jt_pm_")
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
        pg=br.new_context(viewport={"width":390,"height":860}).new_page(); errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)))
        def methods():
            pg.goto(BASE,wait_until="networkidle"); pg.wait_for_timeout(1600)
            pg.evaluate(f"addToCart({pid},1,0)"); pg.wait_for_timeout(400)
            pg.evaluate("openCheckout()"); pg.wait_for_timeout(900)
            pg.fill("#coName","Awa"); pg.fill("#coPhone","2207001122")
            pg.evaluate("coNext()"); pg.wait_for_timeout(600)
            pg.evaluate("document.querySelector('[data-deliv=\\'pickup\\']').click()"); pg.wait_for_timeout(250)
            pg.evaluate("coNext()"); pg.wait_for_timeout(800)
            return pg.evaluate("[...document.querySelectorAll('[data-pay]')].map(e=>e.dataset.pay)")
        m=methods()
        chk("by default every method is still offered", len(m)==6, m)
        chk("and nothing has changed for today's customers", "wave" in m and "cod" in m, m)

        # what he asked for: Pay now plus cash on delivery
        api("/api/admin/settings",{"pay_methods":"cod","modempay_enabled":"1",
            "modempay_secret_key":"sk_test_x","modempay_webhook_secret":"wh_x"},tok)
        m=methods()
        chk("switched down to cash on delivery, only Pay now and that remain",
            m==["online","cod"], m)
        chk("and the chosen method is a real one", pg.evaluate("coData.pay") in ("online","cod"),
            pg.evaluate("coData.pay"))

        # the dead end that must never happen
        api("/api/admin/settings",{"pay_methods":"","modempay_enabled":"0"},tok)
        m=methods()
        chk("a blank list means all of them, not none", len(m)==6, m)
        api("/api/admin/settings",{"pay_methods":"none-of-them","modempay_enabled":"0"},tok)
        m=methods()
        chk("and with every method off and no Pay now, cash on delivery comes back",
            m==["cod"], m)
        chk("so the checkout is never a dead end", len(m)>=1, m)
        chk("no JavaScript errors", not errs, errs[:2])
        br.close()
finally:
    srv.terminate()
    try: srv.wait(timeout=5)
    except Exception: srv.kill()
    shutil.rmtree(DATA,ignore_errors=True)
print()
print("METHODS_FAIL — "+"; ".join(fails) if fails else "METHODS_PASS — methods switch off cleanly and never leave a dead end")
