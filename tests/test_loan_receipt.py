"""A loan someone owes us has a receipt: a reminder when it is overdue, a statement while it is
open, a receipt once paid. It can be sent on WhatsApp as a picture or a text, or printed."""
import os as _os, pathlib as _pl
# Portable paths: run from anywhere, against the repository this file sits in.
REPO = _os.environ.get("JT_REPO") or str(_pl.Path(__file__).resolve().parents[1])
SHOT = str(_pl.Path(__file__).resolve().parent / "_out"); _os.makedirs(SHOT, exist_ok=True)
CHROME = _os.environ.get("PW_CHROMIUM") or None   # None = Playwright's own browser
import os, json, time, tempfile, subprocess, urllib.request, urllib.parse, datetime
from playwright.sync_api import sync_playwright
PORT = 4612
BASE=f"http://127.0.0.1:{PORT}"; DATA=tempfile.mkdtemp(prefix="jt_loanrc_")
subprocess.run(["pkill","-9","-f","[n]ode server.js"],capture_output=True); time.sleep(1)
srv=subprocess.Popen(["node","server.js"],cwd=REPO,env=dict(os.environ,DATA_DIR=DATA,PORT=str(PORT)),
                     stdout=subprocess.PIPE,stderr=subprocess.STDOUT); time.sleep(4)
def api(p,b=None,t=None,m=None):
    data=json.dumps(b).encode() if b is not None else None
    r=urllib.request.Request(BASE+p,data=data,headers={"Content-Type":"application/json",
        **({"Authorization":"Bearer "+t} if t else {})},method=m or ("POST" if data is not None else "GET"))
    return json.loads(urllib.request.urlopen(r).read())
fails=[]
def chk(l,ok,x=""):
    print(("  PASS  " if ok else "  FAIL  ")+l+(("  → "+str(x)) if x else ""))
    if not ok: fails.append(l)
day=lambda n: (datetime.date.today()+datetime.timedelta(days=n)).isoformat()
try:
    tok=api("/api/admin/login",{"username":"owner","password":"jeddah2026"})["token"]
    late=api("/api/admin/loans",{"direction":"given","kind":"cash","party_name":"Lamin Ceesay","party_phone":"7012345",
        "amount":2000,"date_taken":day(-30),"date_due":day(-5)},tok)["id"]
    api(f"/api/admin/loans/{late}/settle",{"mode":"cash","amount":500},tok)
    soon=api("/api/admin/loans",{"direction":"given","kind":"cash","party_name":"Awa Njie","party_phone":"+220 701 9999",
        "amount":800,"date_taken":day(-2),"date_due":day(10)},tok)["id"]
    paid=api("/api/admin/loans",{"direction":"given","kind":"cash","party_name":"Musa Bah","amount":300,"date_taken":day(-9)},tok)["id"]
    api(f"/api/admin/loans/{paid}/settle",{"mode":"cash","amount":300},tok)
    taken=api("/api/admin/loans",{"direction":"taken","kind":"cash","party_name":"Supplier Ltd","amount":5000},tok)["id"]
    loans={l["id"]:l for l in api("/api/admin/loans",t=tok)["loans"]}
    chk("server still holds the payment as made", loans[late]["paid_amount"]==500 and loans[late]["status"]=="active")

    with sync_playwright() as pw:
        br=pw.chromium.launch(**({'executable_path': CHROME} if CHROME else {}))
        ctx=br.new_context(viewport={"width":390,"height":860}); pg=ctx.new_page(); errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(BASE+"/admin",wait_until="networkidle")
        pg.evaluate(f"sessionStorage.setItem('jt_token','{tok}')"); pg.reload(wait_until="networkidle"); pg.wait_for_timeout(1500)
        pg.evaluate("document.querySelector('.navbtn[data-view=loans]').click()"); pg.wait_for_timeout(800)
        btns=pg.evaluate("[...document.querySelectorAll('[data-loan-rc]')].map(b=>+b.dataset.loanRc)")
        chk("every loan someone owes us has a Receipt button", sorted(btns)==sorted([late,soon,paid]), btns)
        chk("a loan the shop owes has none", taken not in btns)

        # --- overdue → payment reminder
        pg.click(f"[data-loan-rc='{late}']"); pg.wait_for_timeout(400)
        prev=pg.inner_text("#loanReceiptPreview")
        chk("an overdue loan gives a payment reminder", "PAYMENT REMINDER" in prev and pg.inner_text("#lrTitle")=="Payment reminder")
        chk("it shows the loan, what was paid and the balance", all(s in prev for s in ["D2,000","D500","D1,500"]), prev.replace("\n"," | "))
        chk("it counts the days overdue", "Days overdue" in prev and "\n5" in prev.replace("\t","\n"))
        chk("it carries the receipt number", f"LN-{late:05d}" in prev)
        href=pg.get_attribute("#lrText","href")
        chk("the WhatsApp text goes to their number with 220 added", href.startswith("https://wa.me/2207012345?text="), href[:40])
        txt=urllib.parse.unquote(href.split("text=")[1])
        chk("…and says the balance and that it is late", "D1,500" in txt and "day" in txt, txt.replace("\n"," | "))
        png=pg.evaluate("loanReceiptCanvas(RECEIPT_LOAN).toDataURL('image/png').length")
        chk("the receipt picture is drawn", png>20000, png)
        pg.evaluate("(()=>{const c=loanReceiptCanvas(RECEIPT_LOAN);window.__png=c.toDataURL('image/png')})()")
        import base64
        open(SHOT+"/loan_reminder.png","wb").write(base64.b64decode(pg.evaluate("window.__png").split(",")[1]))
        pg.screenshot(path=SHOT+"/loan_receipt_modal.png")
        printed=pg.evaluate("receiptDoc({order_number:'LN-x',__html:loanReceiptInner(RECEIPT_LOAN)})")
        chk("the printed copy is the same receipt", "PAYMENT REMINDER" in printed and "D1,500" in printed)
        pg.evaluate("closeModal&&closeModal('loanReceiptModal')") if pg.evaluate("typeof closeModal")=="function" else pg.evaluate("document.getElementById('loanReceiptModal').classList.remove('on')")

        # --- not yet due → statement; paid → receipt with nothing owed
        pg.click(f"[data-loan-rc='{soon}']"); pg.wait_for_timeout(300)
        prev=pg.inner_text("#loanReceiptPreview")
        chk("an open loan gives a statement with its due date", "LOAN STATEMENT" in prev and day(10) in prev and "Days overdue" not in prev)
        chk("a number written +220 … works too", pg.get_attribute("#lrText","href").startswith("https://wa.me/2207019999?"))
        pg.evaluate("document.getElementById('loanReceiptModal').classList.remove('on')")
        pg.click(f"[data-loan-rc='{paid}']"); pg.wait_for_timeout(300)
        prev=pg.inner_text("#loanReceiptPreview")
        chk("a paid loan gives a payment receipt with nothing owed", "PAYMENT RECEIPT" in prev and "D0" in prev and "Paid in full" in prev)
        chk("no phone → no WhatsApp text, and it says why", not pg.is_visible("#lrText") and pg.is_visible("#lrNoPhone"))

        # --- making a receipt changes nothing
        after={l["id"]:l for l in api("/api/admin/loans",t=tok)["loans"]}
        chk("opening receipts changes no loan", all(after[i]["paid_amount"]==loans[i]["paid_amount"] and after[i]["status"]==loans[i]["status"] for i in loans))
        chk("no JavaScript errors", not errs, errs[:3])
        br.close()
finally:
    srv.kill()
print("\nALL PASS" if not fails else f"\n{len(fails)} FAILED: {fails}")
raise SystemExit(1 if fails else 0)
