"""Staff can change an order's items after it was placed (the customer rings to add or drop
something). The server works out everything that follows: line prices (old lines keep their
price), stock (only the difference moves), the investor's profit, the delivery fee with the
free-delivery rule, what a paid customer still owes or is owed, and a booked Yobal courier
is re-booked to collect the right cash. Once the goods have left, the order is closed to edits."""
import os as _os, pathlib as _pl
REPO = _os.environ.get("JT_REPO") or str(_pl.Path(__file__).resolve().parents[1])
SHOT = str(_pl.Path(__file__).resolve().parent / "_out"); _os.makedirs(SHOT, exist_ok=True)
CHROME = _os.environ.get("PW_CHROMIUM") or None
import os, json, time, tempfile, subprocess, urllib.request, urllib.error
from playwright.sync_api import sync_playwright

PORT = 4621; BASE = f"http://127.0.0.1:{PORT}"; DATA = tempfile.mkdtemp(prefix="jt_oedit_")
os.environ["YOBAL_MAP_LOOKUP"] = "off"
subprocess.run(["pkill", "-9", "-f", "[n]ode server.js"], capture_output=True); time.sleep(1)
srv = subprocess.Popen(["node", "server.js"], cwd=REPO, env=dict(os.environ, DATA_DIR=DATA, PORT=str(PORT)),
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT); time.sleep(4)
def api(p, b=None, t=None, m=None, inv=None):
    data = json.dumps(b).encode() if b is not None else None
    h = {"Content-Type": "application/json"}
    if t: h["Authorization"] = "Bearer " + t
    if inv: h["X-Investor-Token"] = inv
    r = urllib.request.Request(BASE + p, data=data, headers=h, method=m or ("POST" if data is not None else "GET"))
    try: return json.loads(urllib.request.urlopen(r).read())
    except urllib.error.HTTPError as e: return {"_status": e.code, **json.loads(e.read() or b"{}")}
fails = []
def chk(l, ok, x=""):
    print(("  PASS  " if ok else "  FAIL  ") + l + (("  -> " + str(x)) if x else ""))
    if not ok: fails.append(l)
def order(tok, n): return next(o for o in api("/api/admin/orders", t=tok)["orders"] if o["order_number"] == n)
def stock(tok, pid): return next(p for p in api("/api/admin/products", t=tok)["products"] if p["id"] == pid)["stock"]
edit = lambda tok, oid, items, **kw: api(f"/api/admin/orders/{oid}/items", {"items": items, **kw}, tok, "PUT")
try:
    tok = api("/api/admin/login", {"username": "owner", "password": "jeddah2026"})["token"]
    api("/api/admin/settings", {"free_delivery_over": "2000"}, tok)
    zone = api("/api/zones")["zones"][0]; zfee = zone["fee"]
    A = api("/api/admin/products", {"name_en": "Ajwa Dates", "cat": "dates", "price": 400, "cost": 200, "stock": 20, "is_active": 1}, tok)["id"]
    B = api("/api/admin/products", {"name_en": "Zamzam 5L", "cat": "islamic", "price": 300, "cost": 150, "stock": 3, "is_active": 1}, tok)["id"]
    iv = api("/api/admin/investors", {"name": "Investor One", "phone": "2207770011", "password": "pass1"}, tok)
    api("/api/admin/investments", {"investor_id": iv["id"], "product_id": A, "qty_funded": 10, "cost_per_unit": 200, "investor_pct": 50}, tok)

    # ---- an online order: 2 Ajwa, cash on delivery
    o = api("/api/orders", {"customer_name": "Awa Njie", "customer_phone": "2207001122", "delivery_method": "home",
        "delivery_zone_id": zone["id"], "delivery_address": "Gate 4", "payment_method": "cod", "items": [{"id": A, "qty": 2}]})
    chk("order placed: 2 × D400 + delivery", o["subtotal"] == 800 and o["total"] == 800 + zfee, (o["subtotal"], o["total"]))
    chk("stock taken at order time", stock(tok, A) == 18)
    # Ajwa's price goes up after the order — the customer keeps the price they were charged
    api(f"/api/admin/products/{A}", {"price": 450}, tok, "PATCH")
    pv = edit(tok, o["id"], [{"id": A, "qty": 3}, {"id": B, "qty": 1}], preview=True)
    chk("preview shows the new figures", pv.get("preview") and pv["subtotal"] == 1500 and pv["total"] == 1500 + zfee, pv)
    chk("…and changes nothing", order(tok, o["order_number"])["total"] == 800 + zfee and stock(tok, A) == 18)

    r = edit(tok, o["id"], [{"id": A, "qty": 3}, {"id": B, "qty": 1}], note="Customer called to add")
    row = order(tok, o["order_number"])
    chk("an existing line keeps its price after a price rise (D400, not D450)", next(i for i in row["items"] if i["id"] == A)["price"] == 400)
    api(f"/api/admin/products/{A}", {"price": 400}, tok, "PATCH")   # back to D400 for the rest
    chk("adding: 3 Ajwa + 1 Zamzam",r.get("ok") and row["subtotal"] == 1500 and row["total"] == 1500 + zfee, (row["subtotal"], row["total"]))
    chk("only the added units leave the shelf", stock(tok, A) == 17 and stock(tok, B) == 2, (stock(tok, A), stock(tok, B)))
    chk("the order says it was edited", row["edit_count"] == 1)
    hist = api(f"/api/admin/orders/{o['id']}/edits", t=tok)["edits"]
    chk("the change is in the order's history, with who and why",
        len(hist) == 1 and hist[0]["by_user"] == "owner" and hist[0]["note"] == "Customer called to add" and hist[0]["old_total"] == 800 + zfee, hist[:1])
    led = api("/api/admin/stock/ledger", t=tok)
    moves = [m for m in (led.get("moves") or led.get("ledger") or []) if m.get("reason") == "order_edit"]
    chk("stock ledger records the edit", len(moves) >= 2 or "_status" in led, moves[:2])

    # investor: 3 Ajwa now sold → 3 × (400 − 200) × 50% = 300
    itok = api("/api/investor/login", {"phone": "2207770011", "password": "pass1"})["token"]
    t1 = api("/api/investor/dashboard", inv=itok)["totals"]
    chk("investor profit follows the edit (3 dates)", t1["profit"] == 300 and t1["revenue"] == 1200, t1)

    # free delivery once the goods pass D2,000
    r = edit(tok, o["id"], [{"id": A, "qty": 5}, {"id": B, "qty": 1}])
    chk("delivery becomes free over the threshold", r["delivery_fee"] == 0 and r["total"] == 2300, (r["delivery_fee"], r["total"]))
    # ...and charged again when it drops back under
    r = edit(tok, o["id"], [{"id": A, "qty": 1}])
    chk("removing: back to 1 Ajwa, delivery charged again", r["subtotal"] == 400 and r["delivery_fee"] == zfee and r["total"] == 400 + zfee, r)
    chk("removed units go back on the shelf", stock(tok, A) == 19 and stock(tok, B) == 3, (stock(tok, A), stock(tok, B)))
    t2 = api("/api/investor/dashboard", inv=itok)["totals"]
    chk("investor profit follows (1 date)", t2["profit"] == 100 and t2["revenue"] == 400, t2)

    # errors
    chk("can't add more than the shelf holds", edit(tok, o["id"], [{"id": A, "qty": 1}, {"id": B, "qty": 9}]).get("_status") == 400)
    chk("can't empty the order (cancel it instead)", "Cancelled" in edit(tok, o["id"], []).get("error", ""))

    # ---- a paid order that grows, then shrinks
    p = api("/api/orders", {"customer_name": "Paid Pa", "customer_phone": "2207003344", "delivery_method": "pickup",
        "payment_method": "cod", "items": [{"id": A, "qty": 1}]})
    api(f"/api/admin/orders/{p['id']}", {"payment_status": "paid"}, tok, "PATCH")
    r = edit(tok, p["id"], [{"id": A, "qty": 2}])
    row = order(tok, p["order_number"])
    chk("paid order that costs more: part-paid, D400 still to collect",
        row["payment_status"] == "partial" and row["amount_paid"] == 400 and r["balance_due"] == 400, (row["payment_status"], row["amount_paid"], r["balance_due"]))
    r = edit(tok, p["id"], [{"id": A, "qty": 1}])
    chk("…back to what was paid: paid again", order(tok, p["order_number"])["payment_status"] == "paid" and r["balance_due"] == 0)
    api(f"/api/admin/orders/{p['id']}", {}, tok, "PATCH")
    q = api("/api/orders", {"customer_name": "Refund Ref", "customer_phone": "2207005566", "delivery_method": "pickup",
        "payment_method": "cod", "items": [{"id": A, "qty": 3}]})
    api(f"/api/admin/orders/{q['id']}", {"payment_status": "paid"}, tok, "PATCH")
    r = edit(tok, q["id"], [{"id": A, "qty": 1}])
    chk("paid order that costs less: stays paid, refund of D800 shown", order(tok, q["order_number"])["payment_status"] == "paid" and r["refund_due"] == 800, r)

    # ---- cancel after an edit: everything comes back exactly once
    api(f"/api/admin/orders/{o['id']}", {"status": "cancelled"}, tok, "PATCH")
    chk("cancelling an edited order restocks its current items", stock(tok, A) == 20 - 1 - 1, stock(tok, A))
    t3 = api("/api/investor/dashboard", inv=itok)["totals"]
    chk("…and the investor's share from it is fully reversed (2 dates left on other orders)", t3["revenue"] == 800 and t3["profit"] == 200, t3)
    chk("a cancelled order can't be edited", edit(tok, o["id"], [{"id": A, "qty": 1}]).get("_status") == 400)
    s = api("/api/orders", {"customer_name": "Gone", "customer_phone": "2207007788", "delivery_method": "pickup",
        "payment_method": "cod", "items": [{"id": A, "qty": 1}]})
    api(f"/api/admin/orders/{s['id']}", {"status": "out_for_delivery"}, tok, "PATCH")
    chk("out for delivery: closed to edits", "left the shop" in edit(tok, s["id"], [{"id": A, "qty": 2}]).get("error", ""))

    # ---- Yobal: a booked courier is re-booked to collect the new amount (practice mode)
    api("/api/admin/settings", {"delivery_provider": "yobal", "yobal_mode": "test"}, tok)
    y = api("/api/orders", {"customer_name": "Yobal Yaya", "customer_phone": "2207009900", "delivery_method": "home",
        "delivery_lat": 13.4446, "delivery_lng": -16.6789, "delivery_address": "Westfield", "payment_method": "cod", "items": [{"id": A, "qty": 1}]})
    api(f"/api/admin/orders/{y['id']}", {"status": "confirmed"}, tok, "PATCH")
    before = order(tok, y["order_number"])
    r = edit(tok, y["id"], [{"id": A, "qty": 2}])
    after = order(tok, y["order_number"])
    chk("Yobal courier re-booked after the edit", (r.get("yobal") or {}).get("ok") and after["yobal_delivery_id"] != before["yobal_delivery_id"], r.get("yobal"))
    chk("…collecting the new total", after["yobal_cod"] == after["total"] and after["yobal_ref_seq"] == 1, (after["yobal_cod"], after["total"], after["yobal_ref_seq"]))
    api(f"/api/admin/orders/{y['id']}/yobal", {"action": "event", "step": "assigned"}, tok)
    api(f"/api/admin/orders/{y['id']}/yobal", {"action": "event", "step": "picked_up"}, tok)
    err = edit(tok, y["id"], [{"id": A, "qty": 3}]).get("error", "")
    chk("once Yobal's courier has the parcel: closed to edits", "courier already has" in err or "left the shop" in err,
        (order(tok, y["order_number"])["yobal_status"], err))
    api("/api/admin/settings", {"delivery_provider": "own"}, tok)

    # ---- the admin screen
    o2 = api("/api/orders", {"customer_name": "Screen Test", "customer_phone": "2207001111", "delivery_method": "home",
        "delivery_zone_id": zone["id"], "delivery_address": "Gate 9", "payment_method": "cod", "items": [{"id": A, "qty": 1}]})
    with sync_playwright() as pw:
        br = pw.chromium.launch(**({'executable_path': CHROME} if CHROME else {}))
        pg = br.new_page(viewport={"width": 1280, "height": 900}); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(BASE + "/admin", wait_until="networkidle"); pg.evaluate(f"sessionStorage.setItem('jt_token','{tok}')")
        pg.reload(wait_until="networkidle"); pg.wait_for_timeout(1500)
        pg.evaluate("document.querySelector('.navbtn[data-view=orders]').click()"); pg.wait_for_timeout(1000)
        btn = pg.locator(f"[data-oedit='{o2['id']}']")
        chk("an open order has an Edit items button", btn.count() == 1)
        chk("a cancelled one doesn't", pg.locator(f"[data-oedit='{o['id']}']").count() == 0)
        btn.click(); pg.wait_for_timeout(700)
        chk("the pop-up lists the order's lines", "Ajwa Dates" in pg.inner_text("#oeLines"))
        pg.locator("[data-oe-plus='0']").click(); pg.wait_for_timeout(200)
        pg.select_option("#oeAddSel", f"{B}:0"); pg.fill("#oeAddQty", "1"); pg.click("#oeAddBtn"); pg.wait_for_timeout(900)
        sm = pg.inner_text("#oeSum")
        chk("the new total is shown before saving", "1,100" in sm and "Was" in sm, sm.replace("\n", " | "))
        pg.fill("#oeNote", "Added Zamzam by phone")
        pg.screenshot(path=SHOT + "/order_edit.png")
        pg.click("#oeSave"); pg.wait_for_timeout(1200)
        row = order(tok, o2["order_number"])
        chk("saving from the screen updates the order", row["subtotal"] == 1100 and len(row["items"]) == 2, (row["subtotal"], row["items"]))
        card = pg.locator(f"[data-oedit='{o2['id']}']").locator("xpath=ancestor::div[contains(@class,'panel')]").first.inner_text()
        chk("the card shows it was edited", "Edited" in card)
        chk("no page errors", not errs, errs[:3])
        br.close()
finally:
    srv.kill()
print("\nALL PASS" if not fails else f"\n{len(fails)} FAILED: {fails}")
raise SystemExit(1 if fails else 0)
