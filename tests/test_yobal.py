"""Yobal Express carries home deliveries: checkout shows Yobal's price for the customer's spot,
confirming the order books the courier, Yobal's signed webhooks move the order along, and the
weekly statement adds up. A stand-in Yobal business API runs here, checks the API key and
records every booking, the way OneSac's joint test did against the real one."""
import os as _os, pathlib as _pl
# Portable paths: run from anywhere, against the repository this file sits in.
REPO = _os.environ.get("JT_REPO") or str(_pl.Path(__file__).resolve().parents[1])
SHOT = str(_pl.Path(__file__).resolve().parent / "_out"); _os.makedirs(SHOT, exist_ok=True)
CHROME = _os.environ.get("PW_CHROMIUM") or None   # None = Playwright's own browser
import os, json, time, hmac, hashlib, tempfile, subprocess, threading, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

PORT, YPORT = 4614, 4631
BASE = f"http://127.0.0.1:{PORT}"; DATA = tempfile.mkdtemp(prefix="jt_yobal_")
KEY, HOOK = "yb_live_testkey123", "whsec_yobal_test"
SHOP = (13.4180, -16.6870)

# ---------------- stand-in Yobal Express business API ----------------
SEEN = []          # every request: (method, path, body, auth)
DELIVERIES = {}
class Yobal(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self, code, body):
        b = json.dumps(body).encode(); self.send_response(code)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0); body = json.loads(self.rfile.read(n) or b"{}")
        auth = self.headers.get("Authorization", ""); SEEN.append(("POST", self.path, body, auth))
        if auth != "Bearer " + KEY: return self.reply(401, {"statusCode": 401, "message": "Invalid API key"})
        if self.path == "/v1/business/quotes":
            d = body["dropoff"]
            if d["lat"] > 13.85: return self.reply(422, {"statusCode": 422, "error": "outside_service_area", "message": "This address is outside our service area"})
            return self.reply(200, {"quoteId": f"q_{len(SEEN)}", "fareButut": 6500, "distanceKm": 3.4, "etaMinutes": 25, "expiresAt": "2099-01-01T00:00:00Z"})
        if self.path == "/v1/business/deliveries":
            ref = body["externalRef"]
            for d in DELIVERIES.values():
                if d["externalRef"] == ref: return self.reply(200, d)
            did = f"d_{len(DELIVERIES)+1}"
            DELIVERIES[did] = {"deliveryId": did, "externalRef": ref, "status": "searching", "deliveryCode": "4821",
                               "trackingUrl": f"http://yobal.example/t/{did}", "fareButut": body["fareButut"]}
            return self.reply(201, DELIVERIES[did])
        if self.path.endswith("/cancel"): return self.reply(200, {"status": "cancelled"})
        self.reply(404, {"message": "not found"})
ysrv = ThreadingHTTPServer(("127.0.0.1", YPORT), Yobal); threading.Thread(target=ysrv.serve_forever, daemon=True).start()

subprocess.run(["pkill","-9","-f","[n]ode server.js"],capture_output=True); time.sleep(1)
srv=subprocess.Popen(["node","server.js"],cwd=REPO,env=dict(os.environ,DATA_DIR=DATA,PORT=str(PORT)),
                     stdout=subprocess.PIPE,stderr=subprocess.STDOUT); time.sleep(4)
def api(p,b=None,t=None,m=None):
    data=json.dumps(b).encode() if b is not None else None
    r=urllib.request.Request(BASE+p,data=data,headers={"Content-Type":"application/json",
        **({"Authorization":"Bearer "+t} if t else {})},method=m or ("POST" if data is not None else "GET"))
    try: return json.loads(urllib.request.urlopen(r).read())
    except urllib.error.HTTPError as e: return {"_status": e.code, **json.loads(e.read() or b"{}")}
def hook(evt, secret=HOOK, age=0):
    raw = json.dumps(evt); t = str(int(time.time()) - age)
    sig = hmac.new(secret.encode(), f"{t}.{raw}".encode(), hashlib.sha256).hexdigest()
    r = urllib.request.Request(BASE+"/api/webhooks/yobal", data=raw.encode(), method="POST",
        headers={"Content-Type":"application/json","Yobal-Signature":f"t={t},v1={sig}"})
    try: res = urllib.request.urlopen(r); return res.status, json.loads(res.read())
    except urllib.error.HTTPError as e: return e.code, {}
fails=[]
def chk(l,ok,x=""):
    print(("  PASS  " if ok else "  FAIL  ")+l+(("  → "+str(x)) if x else ""))
    if not ok: fails.append(l)
def order(tok, n): return next(o for o in api("/api/admin/orders", t=tok)["orders"] if o["order_number"] == n)
try:
    tok=api("/api/admin/login",{"username":"owner","password":"jeddah2026"})["token"]
    pid=api("/api/admin/products",{"name_en":"Ajwa Dates","cat":"dates","price":400,"cost":200,"stock":50,"is_active":1},tok)["id"]
    zone=api("/api/zones")["zones"][0]

    # --- switched off (the default): nothing changes for the shop
    o0=api("/api/orders",{"customer_name":"Own Courier","customer_phone":"7000001","delivery_method":"home","delivery_zone_id":zone["id"],
        "delivery_address":"Gate 4","payment_method":"cod","items":[{"id":pid,"qty":1}]})
    chk("with Yobal off, orders keep the zone fee and own couriers", o0["delivery_fee"]==zone["fee"] and o0.get("delivery_provider")=="own" and not SEEN, o0)
    chk("…and the shop is told so", api("/api/settings")["delivery_provider"]=="own")

    api("/api/admin/settings",{"delivery_provider":"yobal","yobal_mode":"live","yobal_api_url":f"http://127.0.0.1:{YPORT}/v1/business",
        "yobal_api_key":KEY,"yobal_webhook_secret":HOOK,"yobal_pickup_lat":str(SHOP[0]),"yobal_pickup_lng":str(SHOP[1]),"free_delivery_over":"2500"},tok)
    s=api("/api/admin/settings",t=tok)
    chk("the API key and webhook secret are never shown back", s["yobal_api_key"]=="••••••••" and s["yobal_webhook_secret"]=="••••••••")
    chk("…nor reach the public settings", "yobal_api_key" not in json.dumps(api("/api/settings")))
    chk("settings give the webhook address to hand to Yobal", s.get("yobal_webhook_url","").endswith("/api/webhooks/yobal"), s.get("yobal_webhook_url"))
    chk("a zone centre outside The Gambia is refused", api(f"/api/admin/zones/{zone['id']}",{"lat":"51.5","lng":"-0.12"},tok,"PATCH").get("_status")==400)
    api(f"/api/admin/zones/{zone['id']}",{"lat":"13.4549","lng":"-16.5790"},tok,"PATCH")
    t=api("/api/admin/yobal/test",{},tok)
    chk("Test the connection gets a real Yobal price", t.get("fare")==65 and t.get("mode")=="live", t)

    # --- checkout in a real phone browser, with the location shared
    with sync_playwright() as pw:
        br=pw.chromium.launch(**({'executable_path': CHROME} if CHROME else {}))
        ctx=br.new_context(viewport={"width":390,"height":860},is_mobile=True,has_touch=True,
                           geolocation={"latitude":13.4400,"longitude":-16.6800},permissions=["geolocation"])
        pg=ctx.new_page(); errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(BASE,wait_until="networkidle"); pg.wait_for_timeout(1200)
        pg.evaluate(f"addToCart({pid},2,0)"); pg.evaluate("openCheckout()"); pg.wait_for_timeout(600)
        pg.fill("#coName","Awa Njie"); pg.fill("#coPhone","7012345"); pg.evaluate("coNext()"); pg.wait_for_timeout(500)
        chk("checkout offers Use my location", pg.is_visible("#coGps"))
        opts=pg.evaluate("[...document.querySelectorAll('#coZone option')].map(o=>o.textContent)")
        chk("zone names no longer carry the old fixed fee", all("D" not in o for o in opts[1:]), opts[:3])
        pg.select_option("#coZone", str(zone["id"])); pg.wait_for_timeout(700)
        line=pg.inner_text("#coYbPrice")
        chk("choosing an area shows Yobal's price for it", "D65" in line and "Yobal" in line, line)
        pg.click("#coGps"); pg.wait_for_timeout(900)
        line=pg.inner_text("#coYbPrice")
        chk("sharing the location gives the exact price", "D65" in line and "Share your location" not in line, line)
        pg.fill("#coAddr","Blue gate near the mosque"); pg.screenshot(path=SHOT+"/yobal_checkout.png")
        pg.evaluate("coNext()"); pg.wait_for_timeout(400)
        pg.evaluate("document.querySelector('[data-pay=cod]').click()"); pg.wait_for_timeout(200)
        chk("the summary uses Yobal's price", pg.evaluate("deliveryFee()")==65)
        pg.evaluate("coNext()"); pg.wait_for_timeout(300)
        with pg.expect_response(lambda r: r.url.endswith("/api/orders")) as resp: pg.evaluate("placeOrder()")
        o1=resp.value.json(); pg.wait_for_timeout(500)
        chk("the order is charged Yobal's price", o1.get("delivery_fee")==65 and o1.get("total")==865 and o1.get("delivery_provider")=="yobal", o1)
        row=order(tok,o1["order_number"])
        chk("…from the customer's own location", abs(row["delivery_lat"]-13.44)<1e-6 and row["delivery_loc_src"]=="gps", (row["delivery_lat"],row["delivery_loc_src"]))
        chk("…citing the quote they were shown", row["yobal_quote_id"].startswith("q_") and row["yobal_fare"]==65)
        chk("no courier is booked before the order is confirmed", not any(p.endswith("/deliveries") for _,p,_,_ in SEEN))

        # --- confirm → booked
        r=api(f"/api/admin/orders/{o1['id']}",{"status":"confirmed"},tok,"PATCH")
        chk("confirming the order books the Yobal courier", r.get("yobal",{}).get("ok") is True, r.get("yobal"))
        bk=[b for m,p,b,a in SEEN if p.endswith("/deliveries")][-1]
        chk("…with the shop's API key", [a for m,p,b,a in SEEN if p.endswith("/deliveries")][-1]=="Bearer "+KEY)
        chk("…by order number, at the quoted fare", bk["externalRef"]==o1["order_number"] and bk["fareButut"]==6500 and bk["quoteId"]==row["yobal_quote_id"], bk)
        chk("…cash on delivery for the full total, billed to the shop", bk["codButut"]==86500 and bk["payer"]=="business", (bk["codButut"],bk["payer"]))
        chk("…picking up at the shop and dropping at the customer's spot", abs(bk["pickup"]["lat"]-SHOP[0])<1e-6 and abs(bk["dropoff"]["lat"]-13.44)<1e-6 and bk["dropoff"]["approximate"] is False)
        chk("…with Gambian phone numbers in full", bk["dropoff"]["contactPhone"]=="+2207012345", bk["dropoff"]["contactPhone"])
        row=order(tok,o1["order_number"])
        chk("the order holds Yobal's delivery and code", row["yobal_delivery_id"]=="d_1" and row["yobal_code"]=="4821" and row["yobal_status"]=="searching")
        api(f"/api/admin/orders/{o1['id']}",{"status":"packed"},tok,"PATCH")
        chk("moving to Packed does not book twice", len(DELIVERIES)==1)
        tr=api(f"/api/track?ref={o1['order_number']}&phone=7012345")["order"]
        chk("Track your order shows the customer their delivery code", tr["yobal"]["code"]=="4821", tr.get("yobal"))

        # --- Yobal's webhooks
        d=lambda st,**k: {"deliveryId":"d_1","externalRef":o1["order_number"],"status":st,"trackingUrl":"http://yobal.example/t/d_1",**k}
        chk("a forged signature is refused", hook({"id":"e0","type":"delivery.delivered","delivery":d("delivered")},secret="wrong")[0]==401)
        chk("an old signature is refused", hook({"id":"e0b","type":"delivery.delivered","delivery":d("delivered")},age=600)[0]==401)
        chk("…and neither touched the order", order(tok,o1["order_number"])["status"]=="packed")
        st,b=hook({"id":"e1","type":"delivery.courier_assigned","delivery":d("courier_assigned",courier={"name":"Lamin S.","phone":"+2207712345"})})
        row=order(tok,o1["order_number"])
        chk("courier assigned: the shop sees who is coming", st==200 and row["yobal_courier_name"]=="Lamin S." and row["yobal_courier_phone"]=="+2207712345", b)
        chk("the same event twice is applied once", hook({"id":"e1","type":"delivery.courier_assigned","delivery":d("courier_assigned")})[1].get("outcome")=="duplicate")
        hook({"id":"e2","type":"delivery.picked_up","delivery":d("picked_up")})
        chk("picked up: the order is Out for delivery", order(tok,o1["order_number"])["status"]=="out_for_delivery")
        pg.evaluate("closeAll()"); pg.goto(BASE+"/#track="+o1["order_number"]); pg.wait_for_timeout(600)
        pg.fill("#tkPhone","7012345"); pg.click("#tkGo"); pg.wait_for_timeout(900)
        txt=pg.inner_text("#tkResult")
        chk("the tracking page shows the code and the courier", "4821" in txt and "Lamin S." in txt, txt[:160].replace("\n"," | "))
        pg.screenshot(path=SHOT+"/yobal_tracking.png")
        hook({"id":"e3","type":"delivery.delivered","delivery":d("delivered")})
        row=order(tok,o1["order_number"])
        chk("delivered: the order is Delivered and paid, with its delivery date", row["status"]=="delivered" and row["payment_status"]=="paid" and bool(row["delivered_at"]), (row["status"],row["payment_status"],row["delivered_at"]))
        tr=api(f"/api/track?ref={o1['order_number']}&phone=7012345")["order"]
        chk("once delivered, the code is no longer shown", tr["yobal"]["code"]=="")

        # --- admin page draws it
        apg=ctx.new_page(); aerr=[]; apg.on("pageerror", lambda e: aerr.append(str(e)))
        apg.goto(BASE+"/admin",wait_until="networkidle"); apg.evaluate(f"sessionStorage.setItem('jt_token','{tok}')")
        apg.reload(wait_until="networkidle"); apg.wait_for_timeout(1500)
        apg.evaluate("document.querySelector('.navbtn[data-view=orders]').click()"); apg.wait_for_timeout(800)
        box=apg.inner_text("#ordList")
        chk("the admin order shows Yobal's panel, code and fare", "Yobal Express" in box and "4821" in box and "D65" in box, box[:160].replace("\n"," | "))
        apg.evaluate("document.querySelector('.navbtn[data-view=settings]').click()"); apg.wait_for_timeout(900)
        apg.evaluate("setTab('delivery')"); apg.wait_for_timeout(300)   # Yobal lives on the Delivery tab
        chk("Settings has the Yobal Express section", apg.is_visible("#s_delivery_provider") and apg.input_value("#s_delivery_provider")=="yobal")
        chk("…and the weekly statement", "Yobal pays the shop" in apg.inner_text("#ybStmt"), apg.inner_text("#ybStmt")[:120])
        # an area's fee and map point, saved through the screen exactly as the owner would
        apg.evaluate("setTab('delivery')"); apg.wait_for_timeout(300)
        zid=str(zone["id"])
        apg.fill(f"[data-zf='{zid}']","120"); apg.fill(f"[data-zlat='{zid}']","13.4600"); apg.fill(f"[data-zlng='{zid}']","-16.5800")
        apg.click(f"[data-zone-save='{zid}']"); apg.wait_for_timeout(900)
        zz=next(z for z in api("/api/admin/zones",t=tok)["zones"] if z["id"]==zone["id"])
        chk("an area's fee and map point save from the Delivery settings", zz["fee"]==120 and abs(zz["lat"]-13.46)<1e-6 and abs(zz["lng"]+16.58)<1e-6, zz)
        chk("…without saving the rest of the settings form by accident", api("/api/admin/settings",t=tok)["delivery_provider"]=="yobal")
        api(f"/api/admin/zones/{zone['id']}",{"fee":zone["fee"],"lat":"13.4549","lng":"-16.5790"},tok,"PATCH")
        apg.screenshot(path=SHOT+"/yobal_admin_settings.png", full_page=False)
        chk("no JavaScript errors", not errs and not aerr, (errs+aerr)[:3])
        br.close()

    # --- free delivery: the customer pays nothing, the shop still owes Yobal's fare
    o2=api("/api/orders",{"customer_name":"Big Basket","customer_phone":"7000002","delivery_method":"home","delivery_zone_id":zone["id"],
        "delivery_address":"Shop 3","payment_method":"cod","items":[{"id":pid,"qty":7}]})
    r2=order(tok,o2["order_number"])
    chk("over the free-delivery amount the customer pays no delivery", o2["delivery_fee"]==0 and o2["total"]==2800, o2)
    chk("…but the shop owes Yobal the fare, priced from the zone centre", r2["yobal_fare"]==65 and r2["delivery_loc_src"]=="zone", (r2["yobal_fare"],r2["delivery_loc_src"]))
    api(f"/api/admin/orders/{o2['id']}",{"status":"confirmed"},tok,"PATCH")
    chk("…and the zone-centre drop-off is marked approximate", [b for m,p,b,a in SEEN if p.endswith("/deliveries")][-1]["dropoff"]["approximate"] is True)

    # --- cancelled before pickup: the courier is called off
    api(f"/api/admin/orders/{o2['id']}",{"status":"cancelled"},tok,"PATCH")
    chk("cancelling the order calls the Yobal courier off", any(p.endswith("/d_2/cancel") for _,p,_,_ in SEEN) and order(tok,o2["order_number"])["yobal_status"]=="cancelled")

    # --- outside Yobal's area: the sale still goes through, on the shop's own couriers
    o3=api("/api/orders",{"customer_name":"Far Away","customer_phone":"7000003","delivery_method":"home","delivery_zone_id":zone["id"],
        "delivery_lat":"13.90","delivery_lng":"-15.0","delivery_address":"Basse","payment_method":"cod","items":[{"id":pid,"qty":1}]})
    r3=order(tok,o3["order_number"])
    chk("outside Yobal's area the order is kept, on the zone fee and own couriers", o3["delivery_fee"]==zone["fee"] and r3["delivery_provider"]=="own" and "outside" in r3["yobal_error"], (o3["delivery_fee"],r3["delivery_provider"],r3["yobal_error"]))
    q=api("/api/delivery/quote",{"zone_id":zone["id"],"lat":13.90,"lng":-15.0})
    chk("…and checkout says so", q.get("provider")=="own" and q.get("reason")=="outside", q)

    # --- a failed delivery leaves the order open for staff, and Book again works
    o4=api("/api/orders",{"customer_name":"Retry","customer_phone":"7000004","delivery_method":"home","delivery_zone_id":zone["id"],
        "delivery_address":"Gate","payment_method":"cod","items":[{"id":pid,"qty":1}]})
    api(f"/api/admin/orders/{o4['id']}",{"status":"confirmed"},tok,"PATCH")
    did=order(tok,o4["order_number"])["yobal_delivery_id"]
    hook({"id":"e9","type":"delivery.failed","delivery":{"deliveryId":did,"status":"failed","reason":"No courier available"}})
    r4=order(tok,o4["order_number"])
    chk("no courier found: Yobal marks it failed and the order stays open", r4["yobal_status"]=="failed" and r4["status"]=="confirmed" and "No courier" in r4["yobal_error"])
    chk("Book again books a new courier", api(f"/api/admin/orders/{o4['id']}/yobal",{"action":"book"},tok).get("ok") is True)
    chk("Use own courier hands it back to the shop", api(f"/api/admin/orders/{o4['id']}/yobal",{"action":"own"},tok).get("ok") is True and order(tok,o4["order_number"])["delivery_provider"]=="own")

    # --- the weekly statement
    st=api("/api/admin/yobal/statement",t=tok)
    chk("the weekly statement counts the delivered order", st["deliveries"]==1 and st["cash_collected"]==865 and st["fares"]==65 and st["yobal_pays_shop"]==800, st)

    # --- a courier's "delivered" now does everything staff's does
    cid=api("/api/admin/users",{"username":"rider1","name":"Rider One","password":"rider-pass-1","role":"staff","permissions":["delivery"]},tok).get("id")
    o5=api("/api/orders",{"customer_name":"Pickup Test","customer_phone":"7000005","delivery_method":"pickup","payment_method":"cod","items":[{"id":pid,"qty":1}]})
    api(f"/api/admin/orders/{o5['id']}",{"courier_id":cid},tok,"PATCH")
    rtok=api("/api/admin/login",{"username":"rider1","password":"rider-pass-1"}).get("token")
    api(f"/api/admin/deliveries/{o5['id']}",{"action":"delivered","mark_paid":True},rtok,"PATCH")
    r5=order(tok,o5["order_number"])
    chk("a courier marking it delivered stamps the delivery date too", r5["status"]=="delivered" and r5["payment_status"]=="paid" and bool(r5["delivered_at"]), (r5["status"],r5["delivered_at"]))
finally:
    srv.kill(); ysrv.shutdown()
print("\nALL PASS" if not fails else f"\n{len(fails)} FAILED: {fails}")
raise SystemExit(1 if fails else 0)
