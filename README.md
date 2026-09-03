# Iron Ledger

A gym tracker and coach. It measures your physique from a photo, builds a training
split around what it finds, solves your calories and macros into meals you would
actually cook, logs your sessions, and carries a shared board for whoever you send
the link to.

Zero build step, zero dependencies. One HTML file, one serverless route, a service
worker for offline use.

---

## Deploy it

You need a [Vercel](https://vercel.com) account and Node 20+ locally.

```bash
cd iron-ledger
npx vercel          # first run links or creates the project, deploys a preview
npx vercel --prod   # promote to your live URL
```

Answer the prompts with the defaults — **Other** framework, `./` root, no build
command. That is the whole deployment.

**Prefer the dashboard?** Push to GitHub first, then import at
[vercel.com/new](https://vercel.com/new):

```bash
git init && git add -A && git commit -m "Iron Ledger"
gh repo create iron-ledger --private --source=. --push
```

The site works immediately. Today, Body, Plan and Fuel are fully functional the
moment it is live — they run entirely in the browser and need no backend.

---

## Turn on the Crew board

The board needs somewhere to keep posts. Until you connect it, the board loads and
says so plainly; nothing breaks.

1. Vercel dashboard → your project → **Storage** → **Create Database** → **Upstash → Redis**
2. Connect it to this project, all environments.
3. **Deployments** → the latest one → **Redeploy**.

The integration injects the two variables the route reads. It looks for either
naming scheme, so a Vercel-managed store and a direct Upstash project both work:

| Variable | Set by |
| --- | --- |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel Upstash integration |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash directly |

Upstash's free tier covers a board like this comfortably.

### Keeping the board yours

Your live URL is public, so by default anyone holding it can post. Two guards ship
with it:

- **Rate limit** — one post per IP per minute, enforced in the store.
- **Passcode** — set a `CREW_PASSCODE` environment variable in Vercel and redeploy.
  The app then asks for it once per device and remembers it. Reading stays open;
  only posting is gated.

The route also caps posts at 200 (oldest roll off), text at 600 characters, names
at 32, and strips control characters before anything is stored.

---

## What lives where

```
index.html              the entire app — markup, styles, logic, exercise and food data
api/crew.js             GET reads the board, POST adds to it
manifest.webmanifest    home-screen install
sw.js                   offline app shell
icons/                  app icons
vercel.json             cache headers
```

**Nothing personal leaves the device.** Your profile, photos, measurements, logs
and meal plans live in `localStorage` in your browser. The only thing that ever
reaches the server is a Crew post, and only when you press the button. There is no
account, no analytics, no tracking.

That also means clearing site data wipes your history, and your phone and laptop
keep separate ledgers.

---

## Install it on your phone

Open the live URL, then **Share → Add to Home Screen** on iOS, or **Install app**
from the browser menu on Android. It opens full-screen with its own icon and works
in a basement gym with no signal — the service worker keeps the app shell, and
everything except the Crew board runs offline.

---

## Changing things

Everything is in `index.html`, in plain readable sections:

| Want to change | Look for |
| --- | --- |
| Exercises, cues, rep ranges | `const EX = [` |
| Foods and their macros or prices | `const F = {` |
| Meals and their portions | `const MEALS = [` |
| Split templates | `DAY_SLOTS` and `weekShape()` |
| Sets per session, volume targets | `SETS_BY_EXP`, `volTargetFor()` |
| Calorie and macro maths | `nutritionTargets()` |
| Research desk entries | `const BOARD = [` |

Deploying again is `npx vercel --prod`. Online visitors pick up the new version on
their next load. If you add or rename files in `sw.js`'s `SHELL` list, bump the
`CACHE` string in the same file so installed copies refresh.

---

## The numbers behind it

- Weekly set targets and the half-count for assistance sets come from the 2025
  [resistance-training dose–response meta-regression](https://pubmed.ncbi.nlm.nih.gov/41343037/).
- Training frequency follows [Schoenfeld et al.](https://pubmed.ncbi.nlm.nih.gov/30558493/) —
  it moves strength, not size.
- Protein targets sit against [Morton et al., BJSM 2018](https://pubmed.ncbi.nlm.nih.gov/28698222/),
  where returns plateau near 1.6 g/kg.
- Body fat uses the [US Navy circumference method](https://med.libretexts.org/Courses/Irvine_Valley_College/Physiology_Labs_at_Home/03:_Anthropometrics/3.02:_Part_B-_Circumference_Measures/3.2.04:_Part_B4-_The_U.S._Navy_body_fat_estimation_formula);
  waist-to-height follows [NICE NG246](https://www.nice.org.uk/guidance/ng246/chapter/Identifying-and-assessing-overweight-obesity-and-central-adiposity).
- Indian protein figures are drawn from
  [this per-100 g reference](https://www.unlock.fit/high-protein-vegetarian-foods-in-india-complete-list/).

Estimates, not diagnostics. Their value is the trend you see by measuring the same
way each month.
