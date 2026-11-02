"""The shop screen is simple: products on the first screen, one row of categories, and a cart
bar that takes the shopper straight to paying — no hunting for the cart icon."""
import os as _os, pathlib as _pl
# Portable paths: run from anywhere, against the repository this file sits in.
REPO = _os.environ.get("JT_REPO") or str(_pl.Path(__file__).resolve().parents[1])
SHOT = str(_pl.Path(__file__).resolve().parent / "_out"); _os.makedirs(SHOT, exist_ok=True)
CHROME = _os.environ.get("PW_CHROMIUM") or None   # None = Playwright's own browser
import os, json, time, tempfile, subprocess, urllib.request
from playwright.sync_api import sync_playwright
PORT = 4611
BASE=f"http://127.0.0.1:{PORT}"; DATA=tempfile.mkdtemp(prefix="jt_simple_")
subprocess.run(["pkill","-9","-f","[n]ode server.js"],capture_output=True); time.sleep(1)
srv=subprocess.Popen(["node","server.js"],cwd=REPO,env=dict(os.environ,DATA_DIR=DATA,PORT=str(PORT)),
                     stdout=subprocess.PIPE,stderr=subprocess.STDOUT); time.sleep(4)
fails=[]
def chk(l,ok,x=""):
    print(("  PASS  " if ok else "  FAIL  ")+l+(("  → "+str(x)) if x else ""))
    if not ok: fails.append(l)
try:
    with sync_playwright() as pw:
        br=pw.chromium.launch(**({'executable_path': CHROME} if CHROME else {}))
        ctx=br.new_context(viewport={"width":375,"height":812},is_mobile=True,has_touch=True)
        pg=ctx.new_page(); errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(BASE,wait_until="networkidle"); pg.wait_for_timeout(1200)
        vis=lambda sel: pg.evaluate(f"(()=>{{const e=document.querySelector('{sel}');return !!e&&getComputedStyle(e).display!=='none'&&!e.hidden}})()")

        # --- the first screen is products, not banners and tiles
        chk("the big welcome section is off the shop screen", not vis("#heroSection"))
        chk("the category tiles and deal bands are off it too", not any(vis(s) for s in ["#categories","#deals","#arrivals"]))
        top=pg.evaluate("document.querySelector('#prodGrid .prod-card').getBoundingClientRect().top")
        chk("the first product is on the first screen", top<812, round(top))
        cols=pg.evaluate("getComputedStyle(document.getElementById('prodGrid')).gridTemplateColumns.split(' ').length")
        chk("products sit two to a row on a phone", cols==2, cols)
        chk("description and chat are kept for the product page", not vis("#prodGrid .prod-desc") and not vis("#prodGrid .btn-chat"))
        chk("filters wait behind the Filter button", not vis("#filterBar"))
        pg.click("#filterToggle"); chk("…and open when it is tapped", vis("#filterBar")); pg.click("#filterToggle")
        chk("Why us / reviews / FAQ / contact are not on the shop screen", not any(vis(s) for s in ["#why","#testimonials","#faq","#contact","#newsletter"]))
        chk("no cart bar while the basket is empty", not vis("#cartBar"))

        # --- one row of categories filters the products in place
        total=pg.locator("#prodGrid .prod-card").count()
        pg.click("[data-deals]"); pg.wait_for_timeout(200)
        deals=pg.evaluate("[...document.querySelectorAll('#prodGrid .prod-card')].length")
        chk("the Deals button shows only discounted products", 0<deals<=total, f"{deals} of {total}")
        pg.click("#filterChips [data-cat]:not([data-cat='all'])"); pg.wait_for_timeout(200)
        chk("a category button clears Deals and filters by category",
            pg.evaluate("FILTERS.dealsOnly")==False and pg.evaluate("activeCat")!="all")
        pg.click("#filterChips [data-cat='all']"); pg.wait_for_timeout(200)

        # --- add to cart, then pay from the bar without touching the header cart icon
        pg.locator("#prodGrid .prod-card .btn-primary").first.click(); pg.wait_for_timeout(400)
        chk("adding stays on the shop screen", pg.evaluate("location.hash")=="")
        chk("the cart bar appears", vis("#cartBar"))
        bar=pg.inner_text("#cbarTotal")
        chk("it says what is in the basket", "1 item" in bar and "D" in bar, bar)
        sub=pg.evaluate("cartSubtotal()")
        chk("its total is the basket's subtotal", f"{sub:,.0f}" in bar.replace("D",""), (sub,bar))
        btop=pg.evaluate("document.getElementById('cartBar').getBoundingClientRect().bottom")
        ntop=pg.evaluate("document.querySelector('.mobile-nav').getBoundingClientRect().top")
        chk("the bar sits above the bottom menu, not over it", btop<=ntop+1, (round(btop),round(ntop)))
        pg.screenshot(path=SHOT+"/simple_shop.png")
        pg.click("#cbarCheckout"); pg.wait_for_timeout(700)
        chk("Checkout on the bar opens the checkout", pg.evaluate("document.getElementById('checkoutModal').classList.contains('show')"))
        pg.evaluate("closeAll()")
        pg.click("#cbarOpen"); pg.wait_for_timeout(500)
        chk("tapping the summary opens the basket", pg.evaluate("document.getElementById('cartDrawer').classList.contains('show')"))
        pg.evaluate("closeAll()")

        # --- Help holds everything that left the shop screen
        pg.click("#mnHelp"); pg.wait_for_timeout(500)
        chk("Help shows WhatsApp, chat, tracking and call", all(vis(s) for s in ["#helpWa","#helpChat","#helpTrack","#helpCall"]))
        chk("…and Why us, reviews, FAQ and contact", all(vis(s) for s in ["#why","#testimonials","#faq","#contact"]))
        chk("…and not the products", not vis("#shop"))
        chk("the Help tab is highlighted", pg.evaluate("document.querySelector('.mobile-nav a.active').id")=="mnHelp")
        pg.goto(BASE+"/#faq",wait_until="networkidle"); pg.wait_for_timeout(900)
        chk("an old #faq link still opens the FAQ", vis("#faq") and not vis("#shop"))
        pg.click("#mnHome"); pg.wait_for_timeout(400)
        chk("Home brings the products back", vis("#shop") and not vis("#faq"))

        # --- Arabic: every new label has its translation
        pg.click("#langToggle"); pg.wait_for_timeout(500)
        chk("the page turns right-to-left", pg.evaluate("document.documentElement.dir")=="rtl")
        chk("the bar is in Arabic", pg.inner_text("#cbarCheckout").strip()=="الدفع", pg.inner_text("#cbarCheckout"))
        chk("the bottom menu is in Arabic", "مساعدة" in pg.inner_text(".mobile-nav") and "طلباتي" in pg.inner_text(".mobile-nav"))
        chk("the Filter button is in Arabic", "تصفية" in pg.inner_text("#filterToggle"))
        pg.screenshot(path=SHOT+"/simple_shop_ar.png")
        chk("no JavaScript errors", not errs, errs[:3])
        br.close()
finally:
    srv.kill()
print("\nALL PASS" if not fails else f"\n{len(fails)} FAILED: {fails}")
raise SystemExit(1 if fails else 0)
