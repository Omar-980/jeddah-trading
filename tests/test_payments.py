"""Paying online: only a correctly signed webhook may mark an order paid, and only once."""
import os as _os, pathlib as _pl
# Portable paths: run from anywhere, against the repository this file sits in.
REPO = _os.environ.get("JT_REPO") or str(_pl.Path(__file__).resolve().parents[1])
SHOT = str(_pl.Path(__file__).resolve().parent / "_out"); _os.makedirs(SHOT, exist_ok=True)
CHROME = _os.environ.get("PW_CHROMIUM") or None   # None = Playwright's own browser
import os, sys, json, time, hmac, hashlib, tempfile, shutil, subprocess, urllib.request, urllib.error, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT, FAKE_PORT = 4590, 4591
BASE = f"http://127.0.0.1:{PORT}"
DATA = tempfile.mkdtemp(prefix="jt_pay_")
HOOK_SECRET = "whsec_test_abc123"
LAST = {}          # what the fake provider was asked to charge

# ---------- a stand-in for Modem Pay's API ----------
class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
        sent = json.loads(body or "{}")
        LAST["auth"] = self.headers.get("Authorization", "")
        LAST["raw"] = sent
        # Their REST docs wrap every field in a top-level "data" object. Insist on it here,
        # because sending the fields flat is exactly the bug that made the first live order
        # fall through to the WhatsApp screen with no payment page.
        if "data" not in sent:
            LAST["flat_attempt"] = True
            self.send_response(400); self.end_headers()
            self.wfile.write(json.dumps({"message": "Invalid body: expected a data object"}).encode()); return
        req = sent["data"]
        LAST["body"] = req
        if LAST.get("fail"):
            self.send_response(402); self.end_headers()
            self.wfile.write(json.dumps({"message": "card declined"}).encode()); return
        n = LAST.get("n", 0) + 1; LAST["n"] = n
        iid = f"273ac751-369d-4198-8340-{n:012d}"
        INTENTS[f"secret_{n}"] = {"id": iid, "amount": req.get("amount"), "status": "initialized"}
        LAST["intent"] = (f"secret_{n}", iid)
        out = {"status": True, "message": "ok", "data": {
            "intent_secret": f"secret_{n}", "payment_link": f"https://checkout.example/{iid}",
            "amount": req.get("amount"), "currency": req.get("currency"),
            "status": "requires_payment_method"}}
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps(out).encode())

    def do_GET(self):
        # GET /v1/payments/verify?intent_secret=…
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        sec = (q.get("intent_secret") or [""])[0]
        LAST["verify_calls"] = LAST.get("verify_calls", 0) + 1
        it = INTENTS.get(sec)
        if not it:
            self.send_response(404); self.end_headers(); self.wfile.write(b'{"message":"no such intent"}'); return
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps({"status": True, "data": {"status": it["status"],
            "amount": it["amount"], "currency": "GMD"}}).encode())

INTENTS = {}
fake = HTTPServer(("127.0.0.1", FAKE_PORT), Fake)
threading.Thread(target=fake.serve_forever, daemon=True).start()

subprocess.run(["pkill", "-9", "-f", "[n]ode server.js"], capture_output=True); time.sleep(1)
srv = subprocess.Popen(["node", "server.js"], cwd=REPO,
        env=dict(os.environ, DATA_DIR=DATA, PORT=str(PORT),
                 MODEMPAY_API_BASE=f"http://127.0.0.1:{FAKE_PORT}"),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(4)

fails = []
def chk(label, ok, extra=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + (("  → " + str(extra)) if extra else ""))
    if not ok: fails.append(label)

def call(path, body=None, token=None, method=None, headers=None, raw_body=None):
    data = raw_body.encode() if raw_body is not None else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request(BASE + path, data=data,
        headers={"Content-Type": "application/json",
                 **({"Authorization": "Bearer " + token} if token else {}), **(headers or {})},
        method=method or ("POST" if data is not None else "GET"))
    try:
        resp = urllib.request.urlopen(r); return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read())
        except Exception: return e.code, {}

def hook(payload, secret=HOOK_SECRET, tamper=False):
    raw = json.dumps(payload)
    sig = hmac.new(secret.encode(), raw.encode(), hashlib.sha512).hexdigest()
    if tamper: sig = ("0" * 8) + sig[8:]
    return call("/api/webhooks/modempay", raw_body=raw, headers={"x-modem-signature": sig})

def order_status(num, tok):
    return next(o for o in call("/api/admin/orders", token=tok)[1]["orders"] if o["order_number"] == num)

try:
    tok = call("/api/admin/login", {"username": "owner", "password": "jeddah2026"})[1]["token"]
    call("/api/admin/settings", {"free_delivery_over": "99999", "delivery_fee": "150",
        "modempay_enabled": "1", "modempay_secret_key": "sk_test_xyz",
        "modempay_webhook_secret": HOOK_SECRET, "modempay_public_key": "pk_test_xyz"}, tok)
    p = call("/api/admin/products", {"name_en": "Ajwa Dates", "name_ar": "ع", "cat": "herbs",
        "price": 400, "cost": 200, "stock": 50, "is_active": 1}, tok)[1]["id"]

    # ---------- the keys must never leak ----------
    pub = call("/api/settings")[1]
    leaked = [k for k, v in pub.items() if "sk_test" in str(v) or HOOK_SECRET in str(v)]
    chk("the secret keys are not in the public settings", not leaked, leaked)
    chk("but the shop is told online payment is on", pub.get("pay_online") == "1", pub.get("pay_online"))
    adm = call("/api/admin/settings", token=tok)[1]
    chk("and the admin is shown a mask, never the key",
        adm["modempay_secret_key"] == "••••••••" and adm["modempay_webhook_secret"] == "••••••••",
        (adm["modempay_secret_key"], adm["modempay_webhook_secret"]))
    call("/api/admin/settings", {"modempay_secret_key": "••••••••", "store_name": "Jeddah Trading"}, tok)
    chk("saving the mask back does not wipe the stored key",
        call("/api/admin/settings", token=tok)[1]["modempay_secret_key"] == "••••••••", "")

    # ---------- placing an order that pays online ----------
    st, o = call("/api/orders", {"customer_name": "Awa Njie", "customer_phone": "2207001122",
        "delivery_method": "home", "delivery_address": "Latrikunda", "delivery_area": "Serrekunda",
        "payment_method": "online", "items": [{"id": p, "qty": 1}]})
    num = o["order_number"]
    chk("the order is taken and priced here", o["total"] == 550, o["total"])
    chk("a payment link comes back", o.get("payment_link", "").startswith("https://checkout.example"),
        o.get("payment_link"))
    chk("the amount sent to the provider is the server's total, not the browser's",
        LAST["body"]["amount"] == 550, LAST["body"])
    chk("the request is wrapped the way their REST API documents it",
        "data" in LAST["raw"] and not LAST.get("flat_attempt"), list(LAST["raw"]))
    chk("it is sent in dalasi", LAST["body"]["currency"] == "GMD", LAST["body"].get("currency"))
    chk("with the order attached so the webhook can find it",
        LAST["body"]["metadata"]["order_number"] == num, LAST["body"].get("metadata"))
    chk("and authenticated with the secret key", LAST["auth"] == "Bearer sk_test_xyz", LAST["auth"])
    chk("the order starts unpaid", order_status(num, tok)["payment_status"] == "unpaid",
        order_status(num, tok)["payment_status"])

    oid = o["id"]
    secret1, iid1 = LAST["intent"]
    chk("the payment's own id is kept, for matching their webhook",
        order_status(num, tok).get("payment_intent_id") == iid1,
        order_status(num, tok).get("payment_intent_id"))
    # Exactly the shape their docs show — event + payload — with metadata EMPTY, which is the
    # case that made every real confirmation match no order in the first version.
    paid = {"id": "evt_1", "event": "charge.succeeded",
            "payload": {"id": "chg_1", "type": "payment", "amount": 550, "currency": "GMD",
                        "metadata": {}, "payment_intent_id": iid1,
                        "transaction_reference": "WAVE-TX-555"}}

    # ---------- a forged signature must not pay anything ----------
    st, body = hook(paid, tamper=True)
    chk("a forged signature is refused", st == 401, (st, body))
    chk("and the order is still unpaid", order_status(num, tok)["payment_status"] == "unpaid", "")
    st, _ = hook(paid, secret="whsec_guessed_wrong")
    chk("so is a signature made with the wrong secret", st == 401, st)
    st, _ = call("/api/webhooks/modempay", raw_body=json.dumps(paid))
    chk("and no signature at all", st == 401, st)
    chk("still unpaid after three attempts", order_status(num, tok)["payment_status"] == "unpaid", "")

    # ---------- paying less than the order is worth ----------
    short = json.loads(json.dumps(paid)); short["id"] = "evt_short"; short["payload"]["amount"] = 10
    st, body = hook(short)
    chk("a payment short of the total is rejected", st == 200 and "underpaid" in body.get("outcome", ""),
        (st, body))
    chk("and leaves the order unpaid", order_status(num, tok)["payment_status"] == "unpaid", "")

    # ---------- the real thing ----------
    st, body = hook(paid)
    chk("their real message shape, with empty metadata, still finds the order and pays it",
        st == 200 and body.get("outcome") == "paid", (st, body))
    row = order_status(num, tok)
    chk("the order says paid", row["payment_status"] == "paid", row["payment_status"])

    # ---------- delivered twice, as providers do ----------
    st, body = hook(paid)
    chk("the same event arriving again changes nothing",
        st == 200 and body.get("duplicate") is True, (st, body))
    again = json.loads(json.dumps(paid)); again["id"] = "evt_2"
    st, body = hook(again)
    chk("and a fresh event for an order already paid is left alone",
        body.get("outcome") == "already paid", body)

    # ---------- an unrelated event ----------
    st, body = hook({"id": "evt_3", "event": "charge.cancelled",
                     "payload": {"id": "chg_2", "amount": 550, "metadata": {}, "payment_intent_id": iid1}})
    chk("a cancelled charge does not unpay anything", st == 200 and "ignored" in body.get("outcome", ""),
        body)
    chk("the order is still paid", order_status(num, tok)["payment_status"] == "paid", "")

    # ---------- the page the customer lands back on ----------
    st, d = call("/api/payment-status?ref=" + num)
    chk("the return page can see the order is paid", st == 200 and d["status"] == "paid", d)
    st, d = call("/api/payment-status?ref=JT-9999-0000")
    chk("and gives nothing away about an order it does not know", d["status"] == "unknown", d)
    chk("the status answer carries no personal detail", set(d) == {"status"}, list(d))

    # ---------- confirmed directly, with no webhook at all ----------
    st, ob = call("/api/orders", {"customer_name": "Isatou", "customer_phone": "2207009090",
        "delivery_method": "pickup", "payment_method": "online", "items": [{"id": p, "qty": 1}]})
    secret2, iid2 = LAST["intent"]
    before = LAST.get("verify_calls", 0)
    st, d = call("/api/payment-status?ref=" + ob["order_number"])
    chk("while the customer is still paying, it reads unpaid", d["status"] == "unpaid", d)
    chk("and that was asked of Modem Pay directly", LAST.get("verify_calls", 0) == before + 1,
        LAST.get("verify_calls", 0) - before)
    call("/api/payment-status?ref=" + ob["order_number"])
    chk("asking again within seconds does not hammer their API",
        LAST.get("verify_calls", 0) == before + 1, LAST.get("verify_calls", 0) - before)
    INTENTS[secret2]["status"] = "successful"      # the customer pays on their page
    time.sleep(4.3)
    st, d = call("/api/payment-status?ref=" + ob["order_number"])
    chk("once they have paid, it reads paid straight away — no waiting on the webhook",
        d["status"] == "paid", d)
    chk("and the order itself says paid", order_status(ob["order_number"], tok)["payment_status"] == "paid", "")
    late = {"id": "evt_late", "event": "charge.succeeded",
            "payload": {"id": "chg_9", "amount": 550, "metadata": {}, "payment_intent_id": iid2}}
    st, body = hook(late)
    chk("when the webhook arrives afterwards it changes nothing", body.get("outcome") == "already paid", body)

    # ---------- an intent that was never paid must not be marked paid ----------
    st, oc = call("/api/orders", {"customer_name": "Lamin", "customer_phone": "2207008080",
        "delivery_method": "pickup", "payment_method": "online", "items": [{"id": p, "qty": 1}]})
    secret3, _ = LAST["intent"]
    INTENTS[secret3]["status"] = "cancelled"
    time.sleep(4.3)
    st, d = call("/api/payment-status?ref=" + oc["order_number"])
    chk("a cancelled payment stays unpaid", d["status"] == "unpaid", d)

    # ---------- the older shape is still understood ----------
    st, od = call("/api/orders", {"customer_name": "Musa", "customer_phone": "2207007070",
        "delivery_method": "pickup", "payment_method": "online", "items": [{"id": p, "qty": 1}]})
    st, body = hook({"id": "evt_old", "event": "charge.succeeded",
        "data": {"id": "chg_o", "amount": 550, "metadata": {"order_id": str(od["id"])}}})
    chk("a confirmation in the older data shape still works", body.get("outcome") == "paid", body)

    # ---------- the provider being down must not lose the order ----------
    LAST["fail"] = True
    st, o2 = call("/api/orders", {"customer_name": "Modou", "customer_phone": "2207003344",
        "delivery_method": "pickup", "payment_method": "online", "items": [{"id": p, "qty": 1}]})
    LAST["fail"] = False
    chk("if the payment page cannot be opened the order still stands", st == 201 and o2.get("order_number"),
        (st, o2.get("order_number")))
    chk("and the customer is told to pay another way", bool(o2.get("payment_error")), o2.get("payment_error"))

    # ---------- switched off ----------
    call("/api/admin/settings", {"modempay_enabled": "0"}, tok)
    chk("with it switched off the shop stops offering it",
        call("/api/settings")[1].get("pay_online") == "0", "")
    st, o3 = call("/api/orders", {"customer_name": "Binta", "customer_phone": "2207005566",
        "delivery_method": "pickup", "payment_method": "online", "items": [{"id": p, "qty": 1}]})
    chk("and an order asking for it simply gets no link", st == 201 and not o3.get("payment_link"), o3.get("payment_link"))
finally:
    srv.terminate()
    try: srv.wait(timeout=5)
    except Exception: srv.kill()
    fake.shutdown(); shutil.rmtree(DATA, ignore_errors=True)

print()
if fails: print("PAY_FAIL — " + "; ".join(fails)); sys.exit(1)
print("PAY_PASS — only a signed, full, first-time payment marks an order paid")
