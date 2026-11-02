"""The buttons say what they do: Proceed to payment before, WhatsApp receipt after."""
import os as _os, pathlib as _pl
# Portable paths: run from anywhere, against the repository this file sits in.
REPO = _os.environ.get("JT_REPO") or str(_pl.Path(__file__).resolve().parents[1])
SHOT = str(_pl.Path(__file__).resolve().parent / "_out"); _os.makedirs(SHOT, exist_ok=True)
CHROME = _os.environ.get("PW_CHROMIUM") or None   # None = Playwright's own browser
import os, json, time, hmac, hashlib, tempfile, shutil, subprocess, urllib.request
from playwright.sync_api import sync_playwright
PORT = 4599
BASE=f"http://127.0.0.1:{PORT}"; DATA=tempfile.mkdtemp(prefix="jt_pb_")
HOOK="whsec_buttons"
subprocess.run(["pkill","-9","-f","[n]ode server.js"],capture_output=True); time.sleep(1)
srv=subprocess.Popen(["node","server.js"],cwd=REPO,env=dict(os.environ,DATA_DIR=DATA,PORT=str(PORT)),
                     stdout=subprocess.PIPE,stderr=subprocess.STDOUT); time.sleep(4)
def api(p,b=None,t=None,m=None,raw=None,h=None):
    data=raw.encode() if raw is not None else (json.dumps(b).encode() if b is not None else None)
    r=urllib.request.Request(BASE+p,data=data,headers={"Content-Type":"application/json",
        **({"Authorization":"Bearer "+t} if t else {}),**(h or {})},method=m or ("POST" if data is not None else "GET"))
    return json.loads(urllib.request.urlopen(r).read())
fails=[]
def chk(l,ok,x=""):
    print(("  PASS  " if ok else "  FAIL  ")+l+(("  → "+str(x)) if x else ""))
    if not ok: fails.append(l)
try:
    tok=api("/api/admin/login",{"username":"owner","password":"jeddah2026"})["token"]
    api("/api/admin/settings",{"modempay_enabled":"1","modempay_secret_key":"sk_test_x",
        "modempay_webhook_secret":HOOK,"whatsapp_number":"2207093900"},tok)
    pid=api("/api/admin/products",{"name_en":"Ajwa Dates","cat":"herbs","price":400,"cost":200,
        "stock":20,"is_active":1},tok)["id"]
    with sync_playwright() as pw:
        br=pw.chromium.launch(**({'executable_path': CHROME} if CHROME else {}))
        ctx=br.new_context(viewport={"width":390,"height":860}); pg=ctx.new_page(); errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)))
        def to_review(method):
            pg.goto(BASE,wait_until="networkidle"); pg.wait_for_timeout(1500)
            pg.evaluate(f"addToCart({pid},1,0)"); pg.wait_for_timeout(300)
            pg.evaluate("openCheckout()"); pg.wait_for_timeout(900)
            pg.fill("#coName","Awa Njie"); pg.fill("#coPhone","2207001122")
            pg.evaluate("coNext()"); pg.wait_for_timeout(600)
            pg.evaluate("document.querySelector('[data-deliv=\\'pickup\\']').click()"); pg.wait_for_timeout(250)
            pg.evaluate("coNext()"); pg.wait_for_timeout(700)
            pg.click(f'[data-pay="{method}"]'); pg.wait_for_timeout(300)
            hint=pg.inner_text("#payHint")
            pg.evaluate("coNext()"); pg.wait_for_timeout(800)
            return hint
        hint=to_review("online")
        chk("choosing Pay now changes the line under the methods",
            "next screen" in hint.lower() and "whatsapp" not in hint.lower(), repr(hint))
        b=pg.locator("#coPlace")
        chk("the last button says Proceed to payment", "proceed to payment" in b.inner_text().lower(), b.inner_text())
        chk("and is not the WhatsApp button", "btn-wa" not in (b.get_attribute("class") or ""),
            b.get_attribute("class"))
        review=pg.inner_text("#checkoutCard")
        chk("the review names Pay now as the payment, rather than leaving it blank",
            "pay now" in review.lower(), review[review.lower().find("payment"):][:60] if "payment" in review.lower() else review[:60])
        pg.screenshot(path=f"{SHOT}/pay_button_online.png", full_page=False)
        hint=to_review("cod")
        b=pg.locator("#coPlace")
        chk("cash on delivery keeps the WhatsApp button", "btn-wa" in (b.get_attribute("class") or ""),
            b.get_attribute("class"))
        chk("with the WhatsApp line under the methods", "whatsapp" in hint.lower(), repr(hint))

        # ---------- after paying: the WhatsApp receipt button ----------
        o=api("/api/orders",{"customer_name":"Awa","customer_phone":"2207001122","delivery_method":"pickup",
            "items":[{"id":pid,"qty":1}]})
        evt=json.dumps({"id":"evt_b1","event":"charge.succeeded",
            "payload":{"id":"c1","amount":o["total"],"metadata":{"order_id":str(o["id"])}}})
        sig=hmac.new(HOOK.encode(),evt.encode(),hashlib.sha512).hexdigest()
        api("/api/webhooks/modempay",raw=evt,h={"x-modem-signature":sig})
        pg.goto(f"{BASE}/payment/done?ref={o['order_number']}",wait_until="networkidle"); pg.wait_for_timeout(2500)
        body=pg.inner_text("body")
        chk("once paid, the page says so", "payment received" in body.lower(), body[:80])
        wa=pg.locator("#waReceipt")
        chk("and offers to send the receipt on WhatsApp", wa.count()==1 and "receipt" in wa.inner_text().lower(),
            wa.inner_text() if wa.count() else "(none)")
        href=wa.get_attribute("href") if wa.count() else ""
        chk("to the shop's own number", href.startswith("https://wa.me/2207093900"), href[:40])
        chk("with the order number already written in", o["order_number"] in urllib.request.unquote(href),
            urllib.request.unquote(href)[:120])
        pg.screenshot(path=f"{SHOT}/pay_done_paid.png", full_page=False)
        chk("no JavaScript errors", not errs, errs[:2])
        br.close()
finally:
    srv.terminate()
    try: srv.wait(timeout=5)
    except Exception: srv.kill()
    shutil.rmtree(DATA,ignore_errors=True)
print()
print("BUTTONS_FAIL — "+"; ".join(fails) if fails else "BUTTONS_PASS — Proceed to payment before, WhatsApp receipt after")
