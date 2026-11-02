"""Where the delivery fee lands: the shop's side of the books, never the investor's."""
import os as _os, pathlib as _pl
# Portable paths: run from anywhere, against the repository this file sits in.
REPO = _os.environ.get("JT_REPO") or str(_pl.Path(__file__).resolve().parents[1])
SHOT = str(_pl.Path(__file__).resolve().parent / "_out"); _os.makedirs(SHOT, exist_ok=True)
CHROME = _os.environ.get("PW_CHROMIUM") or None   # None = Playwright's own browser
import os, sys, json, time, tempfile, shutil, subprocess, urllib.request, urllib.error

PORT = 4570
BASE = f"http://127.0.0.1:{PORT}"
DATA = tempfile.mkdtemp(prefix="jt_del_")

subprocess.run(["pkill", "-9", "-f", "[n]ode server.js"], capture_output=True); time.sleep(1)
srv = subprocess.Popen(["node", "server.js"], cwd=REPO,
        env=dict(os.environ, DATA_DIR=DATA, PORT=str(PORT)),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(4)

fails = []
def chk(label, ok, extra=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + (("  → " + str(extra)) if extra else ""))
    if not ok: fails.append(label)

def api(path, body=None, token=None, inv=None, method=None):
    r = urllib.request.Request(BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json",
                 **({"Authorization": "Bearer " + token} if token else {}),
                 **({"X-Investor-Token": inv} if inv else {})},
        method=method or ("POST" if body is not None else "GET"))
    try: return json.loads(urllib.request.urlopen(r).read())
    except urllib.error.HTTPError as e: return json.loads(e.read())

try:
    tok = api("/api/admin/login", {"username": "owner", "password": "jeddah2026"})["token"]
    api("/api/admin/settings", {"delivery_fee": "150", "free_delivery_over": "99999",
        "uk_enabled": "1", "uk_delivery_fee": "3.95", "uk_free_over": "45"}, tok)
    zone = api("/api/admin/zones", {"name": "Serrekunda", "fee": 150}, tok)
    zid = zone.get("id") or (zone.get("zone") or {}).get("id")

    # Ajwa at D400, costing D200, half-funded by an investor on a 50% share
    p = api("/api/admin/products", {"name_en": "Ajwa Dates", "name_ar": "ع", "cat": "herbs",
        "price": 400, "cost": 200, "stock": 50, "is_active": 1,
        "ukActive": True, "ukPrice": 9.5, "ukStock": 20}, tok)["id"]
    iv = api("/api/admin/investors", {"name": "Mohammed Jani", "phone": "2207770011",
        "password": "pass1"}, tok)
    api("/api/admin/investments", {"investor_id": iv["id"], "product_id": p,
        "qty_funded": 10, "cost_per_unit": 200, "investor_pct": 50}, tok)

    # one home delivery in Gambia: D400 of dates + D150 to the door
    o = api("/api/orders", {"customer_name": "Awa Njie", "customer_phone": "2207001122",
        "delivery_method": "home", "delivery_zone_id": zid,
        "delivery_address": "Latrikunda", "items": [{"id": p, "qty": 1}]})
    chk("the goods and the delivery are kept apart on the order",
        o["subtotal"] == 400 and o["delivery_fee"] == 150 and o["total"] == 550,
        (o["subtotal"], o["delivery_fee"], o["total"]))

    # ---------- the investor's side ----------
    itok = api("/api/investor/login", {"phone": "2207770011", "password": "pass1"})["token"]
    dash = api("/api/investor/dashboard", inv=itok)
    t = dash["totals"]
    chk("the investor's sales figure is the goods alone, not the D550 paid",
        t["revenue"] == 400, t["revenue"])
    chk("their profit is half of (400 − 200), with no part of the delivery",
        t["profit"] == 100, t["profit"])
    chk("and the delivery fee appears nowhere on their statement",
        all(abs(abs(l["amount"]) - 150) > 0.001 for l in dash["ledger"]),
        [l["amount"] for l in dash["ledger"]])

    rows = api("/api/admin/investments", token=tok)["investments"]
    mine = next(r for r in rows if r["product_id"] == p)
    chk("the shop keeps the other half of the goods profit",
        mine.get("business_profit", mine.get("investor_profit")) == 100,
        (mine.get("investor_profit"), mine.get("business_profit")))

    # ---------- the shop's books ----------
    pl = api("/api/admin/reports?type=pl", token=tok)
    chk("goods and delivery are shown on separate lines",
        pl["goods"] == 400 and pl["delivery"] == 150, (pl["goods"], pl["delivery"]))
    chk("and they add up to the takings", pl["revenue"] == 550, pl["revenue"])
    chk("the delivery money sits in the shop's gross profit",
        pl["grossProfit"] == 350, pl["grossProfit"])   # 550 − 200 cost of the dates

    # paying the rider is an expense, and it nets off properly
    api("/api/admin/expenses", {"category": "Delivery", "description": "Rider — JT order",
        "amount": 100, "spent_on": time.strftime("%Y-%m-%d")}, tok)
    pl2 = api("/api/admin/reports?type=pl", token=tok)
    chk("once the rider is paid and logged, net profit drops by exactly that",
        pl2["netProfit"] == 250, (pl2["netProfit"], pl2["expenses"]))

    # ---------- a pound order must not land in the dalasi books ----------
    uk = api("/api/orders", {"market": "uk", "customer_name": "Aisha Khan",
        "customer_phone": "+447700900123", "customer_email": "a@example.co.uk",
        "postcode": "B12 9QR", "delivery_address": "12 Example Road",
        "delivery_area": "Birmingham", "items": [{"id": p, "qty": 1}]})
    chk("the UK order is taken in pounds", uk.get("currency") == "GBP", uk.get("currency"))
    pl3 = api("/api/admin/reports?type=pl", token=tok)
    chk("and the profit and loss ignores it completely",
        pl3["revenue"] == 550 and pl3["goods"] == 400 and pl3["delivery"] == 150,
        (pl3["revenue"], pl3["goods"], pl3["delivery"]))
    chk("so net profit is unchanged by a pound sale", pl3["netProfit"] == 250, pl3["netProfit"])

    dash2 = api("/api/investor/dashboard", inv=itok)
    chk("and the pound sale reaches no investor",
        dash2["totals"]["profit"] == 100, dash2["totals"]["profit"])

    # ---------- shop pickup charges nothing ----------
    o2 = api("/api/orders", {"customer_name": "Modou", "customer_phone": "2207003344",
        "delivery_method": "pickup", "items": [{"id": p, "qty": 1}]})
    chk("a pickup order is charged no delivery", o2["delivery_fee"] == 0 and o2["total"] == 400,
        (o2["delivery_fee"], o2["total"]))
finally:
    srv.terminate()
    try: srv.wait(timeout=5)
    except Exception: srv.kill()
    shutil.rmtree(DATA, ignore_errors=True)

print()
if fails: print("DELIVERY_FAIL — " + "; ".join(fails)); sys.exit(1)
print("DELIVERY_PASS — the fee is the shop's, kept out of the investor split and out of pounds")
