"""The live database must survive the upgrade: seed on the release now live, then run the new code on it."""
import os as _os, pathlib as _pl
# Portable paths: run from anywhere, against the repository this file sits in.
REPO = _os.environ.get("JT_REPO") or str(_pl.Path(__file__).resolve().parents[1])
SHOT = str(_pl.Path(__file__).resolve().parent / "_out"); _os.makedirs(SHOT, exist_ok=True)
CHROME = _os.environ.get("PW_CHROMIUM") or None   # None = Playwright's own browser
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request

OLD, NEW, DATA = tempfile.mkdtemp(), tempfile.mkdtemp(), tempfile.mkdtemp()
subprocess.run(["pkill", "-9", "-f", "[n]ode server.js"], capture_output=True); time.sleep(1)

# the release currently live = last commit; the candidate = working tree
# The release before this one. Override with JT_BASE_REF (a commit, tag or branch).
BASE_REF = os.environ.get("JT_BASE_REF", "HEAD~1")
if subprocess.run(["git", "-C", REPO, "rev-parse", "--verify", "--quiet", BASE_REF],
                  capture_output=True).returncode != 0:
    print(f"MIGRATION_SKIP — no {BASE_REF} to compare against (shallow clone?). "
          f"Run `git fetch --unshallow`, or set JT_BASE_REF to the release that is live.")
    sys.exit(0)
subprocess.run(f"git -C {REPO} archive {BASE_REF} | tar -x -C {OLD}", shell=True, check=True)
for f in os.listdir(REPO):
    if f.endswith(".js") or f == "package.json":
        shutil.copy(os.path.join(REPO, f), NEW)
for d in ("public", "admin"):
    shutil.copytree(os.path.join(REPO, d), os.path.join(NEW, d), dirs_exist_ok=True)

fails = []
def chk(l, ok, x=""):
    print(("  PASS  " if ok else "  FAIL  ") + l + (("  → " + str(x)) if x else ""))
    if not ok: fails.append(l)

def boot(root, port):
    p = subprocess.Popen(["node", "server.js"], cwd=root,
            env=dict(os.environ, DATA_DIR=DATA, PORT=str(port)),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    time.sleep(5)
    return p

def api(port, path, body=None, tok=None, method=None):
    r = urllib.request.Request(f"http://127.0.0.1:{port}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + tok} if tok else {})},
        method=method or ("POST" if body is not None else "GET"))
    return json.loads(urllib.request.urlopen(r).read() or b"{}")

old = new = None
try:
    old = boot(OLD, 4595)
    t = api(4595, "/api/admin/login", {"username": "owner", "password": "jeddah2026"})["token"]
    pid = api(4595, "/api/admin/products", {"name_en": "Legacy Dates", "cat": "herbs",
        "price": 400, "cost": 200, "stock": 20, "is_active": 1}, t)["id"]
    api(4595, "/api/orders", {"customer_name": "Old Customer", "customer_phone": "2207001111",
        "delivery_method": "pickup", "items": [{"id": pid, "qty": 2}]})
    print("  (seeded on the release that is live now)")
    old.terminate(); old.wait(timeout=10); old = None; time.sleep(1)

    new = boot(NEW, 4596)
    t2 = api(4596, "/api/admin/login", {"username": "owner", "password": "jeddah2026"})["token"]
    orders = api(4596, "/api/admin/orders", tok=t2)["orders"]
    chk("the old order survived the upgrade", len(orders) == 1 and orders[0]["total"] == 800,
        [o.get("total") for o in orders])
    chk("with its customer details intact", orders and orders[0]["customer_name"] == "Old Customer",
        orders and orders[0].get("customer_name"))
    chk("the new payment columns were added", orders and "payment_ref" in orders[0] and "paid_at" in orders[0],
        orders and [k for k in orders[0] if "pa" in k][:6])
    chk("the old product is still on the shelf",
        any("Legacy Dates" in json.dumps(p) for p in api(4596, "/api/products")["products"]), "")
    chk("the payment check works on an order made before it existed",
        api(4596, "/api/payment-status?ref=" + orders[0]["order_number"])["status"] == "unpaid", "")
    chk("online payment stays off until keys are entered",
        api(4596, "/api/settings")["pay_online"] == "0", "")
    chk("and the books are unchanged", api(4596, "/api/admin/reports?type=pl", tok=t2)["revenue"] == 800,
        api(4596, "/api/admin/reports?type=pl", tok=t2)["revenue"])
    # Yobal Express delivery: new columns arrive empty, and nothing changes until it is switched on
    chk("the Yobal Express columns were added to orders", orders and all(k in orders[0] for k in
        ("delivery_provider", "delivery_lat", "yobal_delivery_id", "yobal_status", "yobal_fare", "yobal_code")),
        orders and [k for k in orders[0] if "yobal" in k or "delivery_" in k][:10])
    chk("…empty on the old order", orders and not orders[0]["yobal_delivery_id"] and orders[0]["yobal_fare"] == 0)
    zones = api(4596, "/api/admin/zones", tok=t2)["zones"]
    chk("delivery zones gained a map point, still empty", zones and "lat" in zones[0] and zones[0]["lat"] is None, zones[:1])
    chk("own couriers keep delivering until Yobal is switched on", api(4596, "/api/settings")["delivery_provider"] == "own")
finally:
    for p in (old, new):
        if p:
            p.terminate()
            try: p.wait(timeout=5)
            except Exception: p.kill()
    for d in (OLD, NEW, DATA): shutil.rmtree(d, ignore_errors=True)

print()
if fails: print("MIGRATION_FAIL — " + "; ".join(fails)); sys.exit(1)
print("MIGRATION_PASS — the live database upgrades cleanly")
