# Vet INC — Clinic Onboarding Plan

## Day 1: Get Their Data

**They provide:**
- PMS type (AVImark, Cornerstone, Impromed, etc.)
- Data export — either they send us a file or we connect remotely

**AVImark:** CSV export from their system (we already have the parser)
**Cornerstone:** IDEXX Data Services API or direct DB export
**Other:** We figure it out clinic by clinic for now

**We do:**
1. Register clinic in `std_clinics` + `meta_clinics`
2. Create their admin account (Supabase Auth)
3. Run the standardizer: `node standardize-{pms_type}.js --clinic-id {slug} --input ./data/{slug}/`
4. Pre-compute aggregation tables (usage, prices, KPIs)

**Time: 1-2 hours** (assuming data file is clean)

## Day 2: Run the Engine

**We do:**
1. Inflation catchup campaign auto-generates — scans all services, flags stale prices, calculates gaps
2. Review recommendations ourselves before showing the client
3. Pre-populate `std_service_prices` with current vs suggested
4. Verify numbers look reasonable (no $10,000 cat nail trims)

**Time: 30 minutes**

## Day 3: Demo Day

**On a call with the clinic owner:**
1. Log into clinic.vetinc.ca
2. Show them their Key Indicators — revenue, visits, trends
3. Flip to Pricing Intelligence — "Here are 47 services that haven't kept up with inflation"
4. Show the total: "That's $X,XXX/month in missed revenue"
5. Implement 3-5 easy wins live on the call (high uplift, low risk services)
6. Set expectations: "We'll monitor these daily and flag anything that needs attention"

**Time: 30-60 minute call**

## Week 1: Monitor

**We do daily:**
- Check that new transactions are flowing in
- Verify the implemented price changes are holding
- Run aggregation refresh
- Send a brief summary to the clinic owner (optional — depends on plan)

**They do:**
- Nothing. Just run their clinic.

## Week 2-4: Expand

**We do:**
- Activate 99-cent pricing campaign
- Start margin growth sub-campaigns on specific categories
- Review results weekly
- Flag any services where volume dropped after price increase

**They do:**
- Review recommendations when we send them
- Approve or dismiss each one

## Month 2+: Revenue Share

**We do:**
- Calculate captured uplift (actual revenue vs baseline)
- Send monthly report
- Invoice based on revenue share %

**They do:**
- Pay us.

---

## What We Need Ready (Checklist)

- [x] `std_*` tables deployed
- [x] RLS policies active
- [x] Meta tables (users, clinics, access)
- [ ] Supabase Auth configured on the project
- [ ] Login page on the dashboard
- [ ] Dashboard reading from `std_*` tables (not raw AVImark tables)
- [ ] Standardizer scripts for AVImark (exists, needs full run test)
- [ ] Standardizer scripts for Cornerstone (partially built)
- [ ] Aggregation refresh function (compute usage, prices, KPIs per clinic)
- [ ] A way for clinics to upload data (even just a simple upload page or they email us)

## What We DON'T Need Yet

- Benchmarking (needs multiple clinics)
- Guard system / event-driven alerts (V2)
- Automated PMS connection (manual data export is fine for first 5 clinics)
- Self-service onboarding (we do it manually)
- Mobile app (dashboard works on mobile)
- Marketing site redesign
- Enterprise features (SSO, audit logs, etc.)
