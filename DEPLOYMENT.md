# GovDoc Vault — Deployment Guide

**Firebase Hosting · Vanilla JS · No Build Tool**

---

## Prerequisites

| Tool         | Version | Install                            |
| ------------ | ------- | ---------------------------------- |
| Node.js      | ≥ 18    | [nodejs.org](https://nodejs.org)   |
| Firebase CLI | ≥ 13    | `npm install -g firebase-tools`    |
| Git          | any     | [git-scm.com](https://git-scm.com) |

---

## 1. Firebase Project Setup

### 1.1 Create two Firebase projects

```
govdoc-dev        ← development / testing
govdoc-prod       ← production
```

Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project** for each.

### 1.2 Enable services (both projects)

```
Authentication  → Sign-in method → Phone  → Enable
Firestore       → Create database → Production mode → Choose region
Storage         → Get started → Production mode → Same region as Firestore
```

> Choose the **same region** for Firestore and Storage to avoid cross-region egress charges.

### 1.3 Register a Web App

**Firebase Console → Project Settings → Your Apps → Add App → Web**

Copy the config object — you will need these 6 values:

```
apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId
```

Do this for **both** dev and prod projects.

---

## 2. Local Environment Setup

### 2.1 Clone and link Firebase

```bash
git clone https://github.com/your-org/gov-doc-vault.git
cd gov-doc-vault

firebase login
firebase use --add   # add govdoc-dev as default alias "dev"
firebase use --add   # add govdoc-prod as alias "prod"
```

### 2.2 Create local environment file

```bash
cp __env.example.js __env.js
```

Edit `__env.js` with your **dev** project credentials:

```js
window.__GOV_ENV = {
  FIREBASE_API_KEY: "AIzaSy...",
  FIREBASE_AUTH_DOMAIN: "govdoc-dev.firebaseapp.com",
  FIREBASE_PROJECT_ID: "govdoc-dev",
  FIREBASE_STORAGE_BUCKET: "govdoc-dev.appspot.com",
  FIREBASE_MESSAGING_SENDER_ID: "123456789",
  FIREBASE_APP_ID: "1:123:web:abc",
};
```

> `__env.js` is gitignored. It must **never** be committed.

### 2.3 Set authorised domains

**Firebase Console → Authentication → Settings → Authorised domains**

Add:

```
localhost
your-production-domain.web.app
your-custom-domain.gov.in          ← if using a custom domain
```

---

## 3. Deploy Security Rules

Deploy rules **before** the app — rules must be live before any client traffic.

```bash
# Deploy Firestore rules + indexes
firebase deploy --only firestore --project dev

# Deploy Storage rules
firebase deploy --only storage --project dev

# Verify rules are active in the console before proceeding
```

---

## 4. Local Development Server

Firebase Hosting emulator serves the app exactly as it runs in production (no bundler needed):

```bash
firebase emulators:start --only hosting
# App available at: http://localhost:5000
```

For full local testing with Firestore + Storage emulators:

```bash
firebase emulators:start
# Hosting:   http://localhost:5000
# Firestore: http://localhost:8080
# Storage:   http://localhost:9199
# Emulator UI: http://localhost:4000
```

> When using emulators locally, add emulator connection code to `firebase.config.js` (see Firebase docs on `connectFirestoreEmulator`).

---

## 5. Manual Production Deploy

```bash
# 1. Switch to production project
firebase use prod

# 2. Generate __env.js for production from your secret manager
#    (do NOT commit this file — generate it at deploy time)
cat > __env.js << EOF
window.__GOV_ENV = {
  FIREBASE_API_KEY:             '$(echo $PROD_API_KEY)',
  FIREBASE_AUTH_DOMAIN:         '$(echo $PROD_AUTH_DOMAIN)',
  FIREBASE_PROJECT_ID:          '$(echo $PROD_PROJECT_ID)',
  FIREBASE_STORAGE_BUCKET:      '$(echo $PROD_STORAGE_BUCKET)',
  FIREBASE_MESSAGING_SENDER_ID: '$(echo $PROD_SENDER_ID)',
  FIREBASE_APP_ID:              '$(echo $PROD_APP_ID)',
};
EOF

# 3. Deploy rules first
firebase deploy --only firestore,storage --project prod

# 4. Deploy hosting
firebase deploy --only hosting --project prod

# 5. Remove generated env file immediately
rm __env.js
```

---

## 6. CI/CD — GitHub Actions

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Firebase Hosting

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install Firebase CLI
        run: npm install -g firebase-tools

      - name: Generate __env.js from secrets
        run: |
          cat > __env.js << EOF
          window.__GOV_ENV = {
            FIREBASE_API_KEY:             '${{ secrets.PROD_API_KEY }}',
            FIREBASE_AUTH_DOMAIN:         '${{ secrets.PROD_AUTH_DOMAIN }}',
            FIREBASE_PROJECT_ID:          '${{ secrets.PROD_PROJECT_ID }}',
            FIREBASE_STORAGE_BUCKET:      '${{ secrets.PROD_STORAGE_BUCKET }}',
            FIREBASE_MESSAGING_SENDER_ID: '${{ secrets.PROD_SENDER_ID }}',
            FIREBASE_APP_ID:              '${{ secrets.PROD_APP_ID }}',
            APP_ENV:                      'production'
          };
          EOF

      - name: Deploy Firestore rules + indexes
        run: firebase deploy --only firestore --project ${{ secrets.PROD_PROJECT_ID }} --token ${{ secrets.FIREBASE_TOKEN }}

      - name: Deploy Storage rules
        run: firebase deploy --only storage --project ${{ secrets.PROD_PROJECT_ID }} --token ${{ secrets.FIREBASE_TOKEN }}

      - name: Deploy Hosting
        run: firebase deploy --only hosting --project ${{ secrets.PROD_PROJECT_ID }} --token ${{ secrets.FIREBASE_TOKEN }}

      - name: Remove generated env file
        if: always()
        run: rm -f __env.js
```

### GitHub Secrets required

Go to **GitHub → Repository → Settings → Secrets → Actions → New secret**:

| Secret name           | Value                         |
| --------------------- | ----------------------------- |
| `FIREBASE_TOKEN`      | Output of `firebase login:ci` |
| `PROD_API_KEY`        | Firebase web app apiKey       |
| `PROD_AUTH_DOMAIN`    | Firebase authDomain           |
| `PROD_PROJECT_ID`     | Firebase projectId            |
| `PROD_STORAGE_BUCKET` | Firebase storageBucket        |
| `PROD_SENDER_ID`      | Firebase messagingSenderId    |
| `PROD_APP_ID`         | Firebase appId                |

> Generate `FIREBASE_TOKEN` once: `firebase login:ci` then copy the printed token.

---

## 7. Custom Domain (Optional)

**Firebase Console → Hosting → Add custom domain**

```
1. Enter your domain: vault.gov.in
2. Add the provided TXT record to your DNS
3. Firebase verifies ownership and provisions SSL automatically
4. Add the domain to Firebase Auth → Authorised domains
```

---

## 8. Post-Deploy Verification Checklist

```
□ index.html loads at your hosting URL
□ Phone OTP login works end-to-end
□ Dashboard loads after login (auth guard active)
□ Upload a test document — appears in grid
□ Edit document title — persists on refresh
□ Delete document — removed from grid and Storage
□ Share with a registered phone — member appears in share modal
□ Revoke access — member removed
□ Profile page loads, name save works
□ Sign out redirects to login
□ Direct navigation to /dashboard.html without login → redirects to /index.html
□ Check browser console — no Firebase rule errors (permission-denied)
□ Check Firebase Console → Firestore → Rules → Monitor to confirm rules are hit
```

---

## 9. Firebase Console Post-Setup

### Firestore indexes

After first deploy, some queries may show **"index required"** errors in the console.
Firebase generates a direct link in the error — click it to auto-create the index,
or deploy `firestore.indexes.json` which includes all required indexes:

```bash
firebase deploy --only firestore:indexes --project prod
```

### Storage CORS (if needed)

If you see CORS errors on file downloads, create `cors.json`:

```json
[
  {
    "origin": ["https://your-app.web.app", "https://your-custom-domain.gov.in"],
    "method": ["GET"],
    "maxAgeSeconds": 3600
  }
]
```

Apply with:

```bash
gcloud storage buckets update gs://your-project.appspot.com --cors-file=cors.json
```

---

## 10. Environment Summary

| Environment | Firebase Project | Branch    | `APP_ENV`    |
| ----------- | ---------------- | --------- | ------------ |
| Local dev   | `govdoc-dev`     | any       | _(not set)_  |
| Staging     | `govdoc-dev`     | `develop` | `staging`    |
| Production  | `govdoc-prod`    | `main`    | `production` |

> Setting `APP_ENV: 'production'` in `__env.js` suppresses `DEBUG` logs and stack traces in `logger.service.js` and `firebase.config.js`.
