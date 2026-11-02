"""Deleting an account erases the person and leaves the books, the stock and the investor whole."""
import os as _os, pathlib as _pl
# Portable paths: run from anywhere, against the repository this file sits in.
REPO = _os.environ.get("JT_REPO") or str(_pl.Path(__file__).resolve().parents[1])
SHOT = str(_pl.Path(__file__).resolve().parent / "_out"); _os.makedirs(SHOT, exist_ok=True)
CHROME = _os.environ.get("PW_CHROMIUM") or None   # None = Playwright's own browser
import os, sys, json, time, tempfile, shutil, subprocess, urllib.request, urllib.error

PORT = 4580
BASE = f"http://127.0.0.1:{PORT}"
DATA = tempfile.mkdtemp(prefix="jt_del2_")

subprocess.run(["pkill", "-9", "-f", "[n]ode server.js"], capture_output=True); time.sleep(1)
srv = subprocess.Popen(["node", "server.js"], cwd=REPO,
        env=dict(os.environ, DATA_DIR=DATA, PORT=str(PORT)),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(4)

fails = []
def chk(label, ok, extra=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + (("  → " + str(extra)) if extra else ""))
    if not ok: fails.append(label)

def call(path, body=None, token=None, cust=None, inv=None, method=None, raw=False):
    r = urllib.request.Request(BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json",
                 **({"Authorization": "Bearer " + token} if token else {}),
                 **({"X-Customer-Token": cust} if cust else {}),
                 **({"X-Investor-Token": inv} if inv else {})},
        method=method or ("POST" if body is not None else "GET"))
    try:
        resp = urllib.request.urlopen(r); body = resp.read()
        return (resp.status, body.decode()) if raw else json.loads(body)
    except urllib.error.HTTPError as e:
        b = e.read()
        if raw: return (e.code, b.decode())
        try: return json.loads(b)
        except Exception: return {"error": b.decode()[:80], "status": e.code}

try:
    tok = call("/api/admin/login", {"username": "owner", "password": "jeddah2026"})["token"]
    call("/api/admin/settings", {"free_delivery_over": "99999", "delivery_fee": "150"}, tok)
    p = call("/api/admin/products", {"name_en": "Ajwa Dates", "name_ar": "ع", "cat": "herbs",
        "price": 400, "cost": 200, "stock": 50, "is_active": 1}, tok)["id"]
    iv = call("/api/admin/investors", {"name": "Mohammed Jani", "phone": "2207770011",
        "password": "pass1"}, tok)
    call("/api/admin/investments", {"investor_id": iv["id"], "product_id": p,
        "qty_funded": 10, "cost_per_unit": 200, "investor_pct": 50}, tok)

    # A customer with an account, two orders and a chat thread
    reg = call("/api/customer/register", {"name": "Fatou Ceesay", "phone": "2207005544",
        "password": "1234", "email": "fatou@example.gm"})
    ctok = reg["token"]
    for n in range(2):
        call("/api/orders", {"customer_name": "Fatou Ceesay", "customer_phone": "2207005544",
            "delivery_method": "home", "delivery_address": "12 Kairaba Avenue",
            "delivery_area": "Serrekunda", "items": [{"id": p, "qty": 1}]})
    ch = call("/api/chat/start", {"name": "Fatou Ceesay", "phone": "2207005544",
        "text": "Do you have more dates?"})
    chtok = ch.get("token") or ch.get("cust_token")
    if chtok: call("/api/chat/message", {"text": "Please reply"}, cust=None, method="POST")

    before_pl = call("/api/admin/reports?type=pl", token=tok)
    before_inv = call("/api/investor/dashboard",
                      inv=call("/api/investor/login", {"phone": "2207770011", "password": "pass1"})["token"])
    before_stock = next(x for x in call("/api/admin/products", token=tok)["products"] if x["id"] == p)["stock"]
    chk("two orders are on the books before anything is deleted",
        before_pl["revenue"] == 1100, before_pl["revenue"])          # (400+150) × 2
    chk("and the investor has earned on them", before_inv["totals"]["profit"] == 200,
        before_inv["totals"]["profit"])

    # ---------- the wrong PIN must not delete anything ----------
    bad = call("/api/customer/me", {"password": "9999"}, cust=ctok, method="DELETE")
    chk("a wrong PIN is refused", "error" in bad, bad)
    chk("and the account still exists", "customer" in call("/api/customer/me", cust=ctok),
        call("/api/customer/me", cust=ctok))

    # ---------- the real thing ----------
    out = call("/api/customer/me", {"password": "1234"}, cust=ctok, method="DELETE")
    chk("the right PIN deletes the account", out.get("ok") is True, out)
    chk("and it reports what it kept", out.get("orders") == 2, out)

    chk("the account is gone", "error" in call("/api/customer/me", cust=ctok), "")
    chk("and the PIN no longer signs in",
        "error" in call("/api/customer/login", {"phone": "2207005544", "password": "1234"}), "")
    chk("the phone number can be used to open a fresh account",
        "token" in call("/api/customer/register", {"name": "Someone Else",
            "phone": "2207005544", "password": "5678"}), "")

    # ---------- the books are untouched ----------
    after_pl = call("/api/admin/reports?type=pl", token=tok)
    chk("takings are exactly as before", after_pl["revenue"] == before_pl["revenue"],
        (before_pl["revenue"], after_pl["revenue"]))
    chk("so is gross profit", after_pl["grossProfit"] == before_pl["grossProfit"], "")
    chk("so is delivery income", after_pl["delivery"] == before_pl["delivery"], "")
    after_inv = call("/api/investor/dashboard",
                     inv=call("/api/investor/login", {"phone": "2207770011", "password": "pass1"})["token"])
    chk("the investor's profit is untouched",
        after_inv["totals"]["profit"] == before_inv["totals"]["profit"],
        (before_inv["totals"]["profit"], after_inv["totals"]["profit"]))
    after_stock = next(x for x in call("/api/admin/products", token=tok)["products"] if x["id"] == p)["stock"]
    chk("and the stock count did not move", after_stock == before_stock, (before_stock, after_stock))

    # ---------- but the person is really gone from those orders ----------
    orders = call("/api/admin/orders", token=tok)["orders"]
    chk("both orders are still listed", len(orders) == 2, len(orders))
    chk("with no name on them",
        all(o["customer_name"] == "Deleted customer" for o in orders),
        [o["customer_name"] for o in orders])
    chk("no phone number", all(not o.get("customer_phone") for o in orders),
        [o.get("customer_phone") for o in orders])
    chk("and no address", all(not o.get("delivery_address") for o in orders),
        [o.get("delivery_address") for o in orders])
    chk("their order totals survive intact", all(o["total"] == 550 for o in orders),
        [o["total"] for o in orders])
    convs = call("/api/admin/chat/conversations", token=tok)
    rows = convs.get("conversations", convs.get("threads", []))
    chk("the message thread is gone",
        not any("2207005544" in str(c.get("customer_phone", "")) for c in rows), len(rows))

    # ---------- the pages a reviewer opens ----------
    for path, must in (("/privacy", "Privacy Policy"), ("/delete-account", "Delete my account")):
        st, body = call(path, raw=True)
        chk(f"{path} opens for anyone", st == 200 and must in body, (st, body[:60]))
    st, _ = call("/.well-known/assetlinks.json", raw=True)
    chk("the Android link file stays absent until the app is signed", st == 404, st)
    call("/api/admin/settings", {"android_package": "gm.jeddahtrading.shop",
        "android_cert_sha256": "AA:BB:CC"}, tok)
    st, body = call("/.well-known/assetlinks.json", raw=True)
    ok = st == 200 and json.loads(body)[0]["target"]["package_name"] == "gm.jeddahtrading.shop"
    chk("and appears once the fingerprint is entered", ok, (st, body[:90]))
finally:
    srv.terminate()
    try: srv.wait(timeout=5)
    except Exception: srv.kill()
    shutil.rmtree(DATA, ignore_errors=True)

print()
if fails: print("DELETE_FAIL — " + "; ".join(fails)); sys.exit(1)
print("DELETE_PASS — the person is erased, the money is whole")
