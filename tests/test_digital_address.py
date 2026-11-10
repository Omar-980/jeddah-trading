"""Customers can give a digital address — a Google Maps Plus Code such as "C8VC+RC Serrekunda",
the full code "7C55C8VC+RC", or pasted map coordinates — in the checkout location box. The shop
decodes it itself (no outside service), uses the exact spot for the delivery area and Yobal's
price, keeps the code on the order, and shows it to staff, couriers and the customer's tracking
page with a Google Maps link."""
import os as _os, pathlib as _pl
REPO = _os.environ.get("JT_REPO") or str(_pl.Path(__file__).resolve().parents[1])
SHOT = str(_pl.Path(__file__).resolve().parent / "_out"); _os.makedirs(SHOT, exist_ok=True)
CHROME = _os.environ.get("PW_CHROMIUM") or None
import os, json, time, tempfile, subprocess, urllib.request, urllib.error, urllib.parse
from playwright.sync_api import sync_playwright

PORT = 4618
BASE = f"http://127.0.0.1:{PORT}"; DATA = tempfile.mkdtemp(prefix="jt_plus_")
WESTFIELD = (13.444563, -16.678937)          # centre of 7C55C8VC+RC
os.environ["YOBAL_MAP_LOOKUP"] = "off"
subprocess.run(["pkill", "-9", "-f", "[n]ode server.js"], capture_output=True); time.sleep(1)
srv = subprocess.Popen(["node", "server.js"], cwd=REPO, env=dict(os.environ, DATA_DIR=DATA, PORT=str(PORT)),
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT); time.sleep(4)
def api(p, b=None, t=None, m=None):
    data = json.dumps(b).encode() if b is not None else None
    r = urllib.request.Request(BASE + p, data=data, headers={"Content-Type": "application/json",
        **({"Authorization": "Bearer " + t} if t else {})}, method=m or ("POST" if data is not None else "GET"))
    try: return json.loads(urllib.request.urlopen(r).read())
    except urllib.error.HTTPError as e: return {"_status": e.code, **json.loads(e.read() or b"{}")}
places = lambda q: api("/api/places?q=" + urllib.parse.quote(q))
fails = []
def chk(l, ok, x=""):
    print(("  PASS  " if ok else "  FAIL  ") + l + (("  -> " + str(x)) if x else ""))
    if not ok: fails.append(l)
def order(tok, n): return next(o for o in api("/api/admin/orders", t=tok)["orders"] if o["order_number"] == n)
near = lambda a, b: abs(a - b) < 1e-5
try:
    tok = api("/api/admin/login", {"username": "owner", "password": "jeddah2026"})["token"]
    pid = api("/api/admin/products", {"name_en": "Ajwa Dates", "cat": "dates", "price": 400, "cost": 200, "stock": 50, "is_active": 1}, tok)["id"]

    # --- the search box reads digital addresses
    r = places("C8VC+RC Serrekunda")
    p = (r.get("places") or [{}])[0]
    chk("a short Plus Code with its town is read as a digital address", r.get("digital") == "ok" and p.get("code") == "7C55C8VC+RC"
        and near(p["lat"], WESTFIELD[0]) and near(p["lng"], WESTFIELD[1]), r)
    chk("…and says which area it is in", p.get("detail") == "Westfield", p.get("detail"))
    r = places("c8vc+rc")
    chk("a short code alone (lower case) is read around Greater Banjul", r.get("digital") == "ok" and r["places"][0]["code"] == "7C55C8VC+RC", r)
    r = places("C8VC+RC, Serrekunda, The Gambia")
    chk("the code exactly as Google Maps copies it", r.get("digital") == "ok" and r["places"][0]["code"] == "7C55C8VC+RC", r)
    r = places("7C55C8VC+RC")
    chk("a full code", r.get("digital") == "ok" and r["places"][0]["code"] == "7C55C8VC+RC")
    r = places("https://plus.codes/7C55C8VC+RC")
    chk("a plus.codes link", r.get("digital") == "ok" and r["places"][0]["code"] == "7C55C8VC+RC")
    r = places("13.4446, -16.6789")
    chk("pasted map coordinates become a digital address", r.get("digital") == "ok" and r["places"][0]["code"] == "7C55C8VC+RC", r)
    r = places("8Q6J+22 Basse")
    chk("an upcountry code is read at its own town", r.get("digital") == "ok" and r["places"][0]["code"] == "7C578Q6J+22"
        and abs(r["places"][0]["lng"] + 14.22) < 0.01, r)
    r = places("8FVC9G8F+6X")
    chk("a code outside The Gambia is refused with a reason", r.get("digital") == "outside" and r.get("places") == [], r)
    r = places("kairaba")
    chk("ordinary searches are unchanged", "digital" not in r and any("Kairaba" in x["name"] for x in r["places"]), r)
    r = places("C8VC+")
    chk("a half-typed code isn't read early", "digital" not in r, r)

    # --- orders: the shop decodes the code itself (own couriers)
    o = api("/api/orders", {"customer_name": "Code Customer", "customer_phone": "7000101", "delivery_method": "home",
        "delivery_address": "Blue gate", "payment_method": "cod", "delivery_plus_code": "7c55c8vc+rc",
        "delivery_lat": 13.9, "delivery_lng": -14.0, "items": [{"id": pid, "qty": 1}]})
    chk("an order with a digital address goes through", o.get("order_number"), o)
    row = order(tok, o["order_number"])
    chk("…keeps the full code", row["delivery_plus_code"] == "7C55C8VC+RC", row["delivery_plus_code"])
    chk("…at the spot the code names, not what the browser said", near(row["delivery_lat"], WESTFIELD[0]) and row["delivery_loc_src"] == "code",
        (row["delivery_lat"], row["delivery_loc_src"]))
    chk("…and finds its delivery area from it", row["delivery_zone"] == "Serrekunda", row["delivery_zone"])
    tr = api(f"/api/track?ref={o['order_number']}&phone=7000101")
    chk("tracking shows the customer their digital address", tr["order"]["delivery_plus_code"] == "7C55C8VC+RC")
    bad = api("/api/orders", {"customer_name": "X", "customer_phone": "7000102", "delivery_method": "home", "delivery_address": "x",
        "payment_method": "cod", "delivery_plus_code": "8FVC9G8F+6X", "items": [{"id": pid, "qty": 1}]})
    chk("a code outside The Gambia is refused at the order", bad.get("_status") == 400 and "outside" in bad.get("error", ""), bad)
    junk = api("/api/orders", {"customer_name": "Y", "customer_phone": "7000103", "delivery_method": "home", "delivery_address": "x",
        "delivery_zone_id": api("/api/zones")["zones"][0]["id"], "payment_method": "cod", "delivery_plus_code": "not a code", "items": [{"id": pid, "qty": 1}]})
    chk("rubbish in the code field is ignored, the order still goes", junk.get("order_number") and order(tok, junk["order_number"])["delivery_plus_code"] == "")
    pk = api("/api/orders", {"customer_name": "Z", "customer_phone": "7000104", "delivery_method": "pickup", "payment_method": "cod",
        "delivery_plus_code": "7C55C8VC+RC", "items": [{"id": pid, "qty": 1}]})
    chk("a shop pickup doesn't keep a delivery code", order(tok, pk["order_number"])["delivery_plus_code"] == "")

    # --- checkout in a phone browser, Yobal Express on (practice mode)
    api("/api/admin/settings", {"delivery_provider": "yobal", "yobal_mode": "test"}, tok)
    with sync_playwright() as pw:
        br = pw.chromium.launch(**({'executable_path': CHROME} if CHROME else {}))
        pg = br.new_page(viewport={"width": 390, "height": 860}, is_mobile=True, has_touch=True); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(BASE, wait_until="networkidle"); pg.wait_for_timeout(1200)
        pg.evaluate(f"addToCart({pid},1,0)"); pg.evaluate("openCheckout()"); pg.wait_for_timeout(600)
        pg.fill("#coName", "Awa Njie"); pg.fill("#coPhone", "7012345"); pg.evaluate("coNext()"); pg.wait_for_timeout(500)
        chk("checkout tells customers they can paste a digital address", "digital address" in pg.get_attribute("#coLoc", "placeholder").lower()
            and "Plus Code" in pg.inner_text(".place-hint"))
        pg.click("#coLoc"); pg.fill("#coLoc", "C8VC+RC Serrekunda"); pg.dispatch_event("#coLoc", "input")
        pg.wait_for_function("document.querySelector('#coLocList [data-pl]')", timeout=8000)
        lst = pg.inner_text("#coLocList")
        chk("pasting a code shows it as the digital address", "digital address" in lst.lower() and "7C55C8VC+RC" in lst and "Delivery areas" not in lst,
            lst.replace("\n", " | "))
        pg.screenshot(path=SHOT + "/digital_address_list.png")
        pg.locator("#coLocList [data-pl]").first.dispatch_event("mousedown"); pg.wait_for_timeout(1000)
        picked = pg.evaluate("({lat:coData.lat,zone:coData.zoneId,kind:coData.placeKind,code:coData.plusCode})")
        chk("picking it uses the exact spot and finds the area", near(picked["lat"], WESTFIELD[0]) and picked["zone"] and picked["kind"] == "code"
            and picked["code"] == "7C55C8VC+RC", picked)
        line = pg.inner_text("#coYbPrice")
        chk("…priced by Yobal for that spot, with no 'approximate' note", "Yobal" in line and "D" in line and "centre" not in line.lower(), line)
        pg.fill("#coAddr", "Blue gate near the mosque"); pg.screenshot(path=SHOT + "/digital_address_checkout.png")
        pg.evaluate("coNext()"); pg.wait_for_timeout(400)
        pg.evaluate("document.querySelector('[data-pay=cod]').click()"); pg.wait_for_timeout(200)
        pg.evaluate("coNext()"); pg.wait_for_timeout(300)
        chk("the review shows the code", "7C55C8VC+RC" in pg.inner_text("#rvDeliv"))
        chk("the WhatsApp copy of the order carries the code and a map link", "plus.codes/7C55C8VC%2BRC" in pg.evaluate("buildWaMessage('X')"))
        with pg.expect_response(lambda r: r.url.endswith("/api/orders")) as resp: pg.evaluate("placeOrder()")
        o1 = resp.value.json(); pg.wait_for_timeout(500)
        row = order(tok, o1["order_number"])
        chk("the order goes by Yobal to the code's spot", row["delivery_provider"] == "yobal" and row["delivery_plus_code"] == "7C55C8VC+RC"
            and near(row["delivery_lat"], WESTFIELD[0]) and row["delivery_loc_src"] == "code", (row["delivery_provider"], row["delivery_loc_src"]))
        r = api(f"/api/admin/orders/{o1['id']}", {"status": "confirmed"}, tok, "PATCH")
        chk("confirming books Yobal as usual", (r.get("yobal") or {}).get("ok") is True, r.get("yobal"))
        # Arabic: the hint is translated, and the code stays left-to-right
        pg.evaluate("LANG='ar';applyLang();renderCheckout()"); pg.wait_for_timeout(400)
        hint = pg.inner_text(".place-hint")
        chk("the hint is in Arabic too", "Plus Code" in hint and "عنوان" in hint, hint)
        pg.screenshot(path=SHOT + "/digital_address_ar.png")
        chk("no page errors in the shop", not errs, errs[:3])

        # admin: staff see the code with a map link
        apg = br.new_page(viewport={"width": 1280, "height": 900}); aerrs = []
        apg.on("pageerror", lambda e: aerrs.append(str(e)))
        apg.goto(BASE + "/admin", wait_until="networkidle"); apg.evaluate(f"sessionStorage.setItem('jt_token','{tok}')")
        apg.reload(wait_until="networkidle"); apg.wait_for_timeout(1500)
        apg.evaluate("document.querySelector('.navbtn[data-view=orders]').click()"); apg.wait_for_timeout(1200)
        links = apg.evaluate("[...document.querySelectorAll('a[href*=\"google.com/maps\"]')].map(a=>a.href)")
        chk("the admin order list links the code to Google Maps", any("7C55C8VC%2BRC" in h for h in links), links[:3])
        apg.screenshot(path=SHOT + "/digital_address_admin.png")
        chk("no page errors in the admin", not aerrs, aerrs[:3])
        br.close()
finally:
    srv.kill()
print("\nALL PASS" if not fails else f"\n{len(fails)} FAILED: {fails}")
raise SystemExit(1 if fails else 0)
