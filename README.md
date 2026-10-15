# Shorts Clip Studio v2

Lambi video se **best moments** nikalo aur unhe **9:16 vertical Shorts** me badlo — bilkul us style me jo sample me tha:

- **720×1280 canvas** (9:16)
- **Upar:** safed title patti (bold kala text, emoji support, khud editable)
- **Darmiyan:** 16:9 video centered; khaali jagah me video ka hi **blurred + gehra** copy
- **Neeche:** lafz-ba-lafz **karaoke captions** — bola hua lafz peela highlight; `*lafz*` likhne par surkh/sabz/peele rang
- **B-roll:** apni tasveer/video kisi bhi waqt par lagao — crossfade ke saath

100% browser me chalta hai — **koi server nahi, koi upload nahi**, video aapke phone/PC se bahar nahi jaati.

## Features

1. **Upload:** file picker + drag & drop (bari files bhi — streaming, base64 nahi)
2. **Smart moment detection:** Web Audio API se audio ki energy nikali jaati hai, har 1-second window score hota hai, aur **12 tak** non-overlapping clip tajweez banti hain (video ki lambai ke hisab se). Har card me thumbnail, waqt, score.
3. **Clip lambai:** 30s / 45s / 65s buttons + custom seconds
4. **Editor:** title, transcript (`[MM:SS.s] text` format, ya saada text khud taqseem ho jaata hai), B-roll list (upload + waqt + muddat)
5. **Live preview:** play/pause, scrubber, waqt — canvas par sab kuch asal me render hota hai
6. **Export:** `canvas.captureStream(30)` + MediaRecorder; MP4 jahan supported (Chrome/Edge), warna WebM — imandaar note ke saath. Har clip ka alag download button.
7. **PWA:** phone par install ho jaata hai, offline bhi chalta hai (service worker cache)
8. **☁️ Drive se lao:** Google Drive ka share link paste karein → app Drive API se video download karke seedha load kar deti hai. Settings me **Google API Key** (muft) darkar + file "Anyone with the link" par share honi chahiye. Download me progress bar.

## AI Features (online — v2.1, sirf muft providers)

⚙️ **Settings** (upar gear icon): Groq API key (muft — console.groq.com/keys), Pixabay API key, aur keyless toggles (Pollinations / Puter.js). Keys **sirf aapke browser** (localStorage) me rehti hain. **Koi paid API nahi** — chain hamesha muft providers par girti hai: Groq → Pollinations (keyless) → Puter.js.

1. **✨ AI Title:** har suggestion card par aur editor me — transcript se 3 catchy titles, chip dabao to lag jaaye. Transcript khaali ho to pehle AI Transcript khud chal jaata hai.
2. **🎙 AI Transcript (video se):** clip ke 5 frames (640px) vision AI ko bhej kar timed captions `[MM:SS.s]` banata hai — Groq vision → Pollinations vision. **Imandaar note: AI andaza lagata hai, ghalat ho sakta hai — zaroor check karo.**
3. **🔍 Pixabay B-roll:** keyword likho (ya transcript se auto-suggested chips dabao) → 6 tasveeren → tap karo to playhead ke waqt par B-roll lag jaata hai (fetch→blob, canvas taint nahi hota).
4. **🌐 Translate:** 10 zabanein (English, Urdu, German, Brazilian Portuguese, Hindi, Arabic, French, Spanish, Turkish, Indonesian) — timestamps mehfooz, sirf text translate hota hai.

Har request me 60s timeout + Roman Urdu error messages + agle provider par graceful fallback.

## Professional Polish (v2.1)

- **Safe margins:** title (upar 60px, sides 40px) aur captions (neeche 120px, sides 40px) frame ke kinaron se andar — phone UI me nahi kat-te.
- **Smooth punch-in:** har 3.5s me video par halka eased zoom (1.0x → 1.08x); naya clip = zoom reset.
- **Captions:** bold 44px, 6px black outline + halki shadow, max 2 lines, cue change par 150ms fade.
- **Audio:** export me shuru/aakhir me 300ms fade-in/out — katka nahi lagta.
- **Title auto-fit:** lamba title chhote font me max 2 lines me fit, frame se bahar kabhi nahi.
- **Thumbnails:** suggestion cards ke thumbnails 480px — taiz aur saaf.

## GitHub Pages par deploy (3 steps)

1. Is folder ke tamam files (`index.html`, `styles.css`, `app.js`, `manifest.json`, `sw.js`, `icon-*.png`, `icon.svg`, `README.md`) apne GitHub repo me push karein (koi build step nahi — seedha files).
2. GitHub me **Settings → Pages** kholein, **Source** me `Deploy from a branch` chunein, branch `main` aur folder `/ (root)` rakhein, **Save** dabayein.
3. 1–2 minute me link mil jayega: `https://<username>.github.io/<repo>/` — phone ke Chrome me kholein.

**Phone par install:** Chrome me link kholein → ⋮ menu → **"Add to Home screen" / "Install app"**. Phir app alag icon se khulegi (standalone, portrait).

## Browser requirements

- **Behtareen:** Chrome / Edge (desktop ya Android) — MP4 export, audio analysis, sab kuch
- **Chalta hai:** Firefox (MP4 ki jagah WebM export ho sakta hai)
- Safari: bunyadi kaam karega; purane versions me blur effect saada gehre parde se badal jaata hai
- Service worker (offline/PWA) ke liye **HTTPS** zaroori hai — GitHub Pages par by default hota hai

## Imandaar limitations

- **Drive import:** internet + Settings me Google API Key (muft) darkar; file **"Anyone with the link"** par share honi chahiye. Key banane ke steps: Google Cloud Console → naya project → **Drive API enable** → Credentials → API key. Drive ke share-page link (drive.google.com/file/d/…/view) seedha download nahi ho sakte — is liye Drive API use hoti hai, jo public files ke liye CORS support karti hai.
- **Captions:** khud likh sakte ho, ya **🎙 AI Transcript** video ke frames se andaza lagata hai (internet + Settings me provider darkar; **ghalat ho sakta hai — check zaroori**). Format: har line `[MM:SS.s] text`, ya saada text — app khud taqseem kar dega.
- **MP4 export browser par munhasir hai:** MediaRecorder jahan MP4 support karta hai (Chrome/Edge) wahan MP4 milega; warna WebM — app pehle hi bata dega.
- **Moment detection ke liye poori file memory me aati hai** (`decodeAudioData`) — bahut bari files (1GB+) kamzor phone par slow ho sakti hain.
- Export **asal waqt** me hota hai (30s clip = 30s recording). Tab band na karein.
- B-roll videos me awaz nahi aati (sirf tasveer/video dikhti hai) — asal clip ki awaz rehti hai.

## Files

| File | Kaam |
|---|---|
| `index.html` | Layout + PWA wiring |
| `styles.css` | Dark theme, mobile-friendly |
| `app.js` | Saari logic (koi dependency nahi) |
| `manifest.json` | PWA manifest |
| `sw.js` | Offline cache service worker |
| `icon-192.png` / `icon-512.png` / `icon.svg` | App icons (clapperboard) |
