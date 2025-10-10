# Discourse NEAR Plugin

Link NEAR accounts to Discourse accounts using **NEP-413 message signing**.

Built using [`near-sign-verify`](https://github.com/elliotBraem/near-sign-verify).

---

## ⚙️ Setup

```bash
bun install
cp .env.example .env
# Edit .env with your credentials
bun run dev
```

### Environment Variables

```bash
DISCOURSE_BASE_URL=https://discuss.near.vote
DISCOURSE_API_KEY=your__api_key
DISCOURSE_API_USERNAME=your_username
DISCOURSE_RECIPIENT=social.near
PORT=3001
```

---

## 🧩 API

### Generate Auth URL

```bash
POST /api/auth/user-api-url
```

**Request**

```json
{
  "clientId": "discourse-near-plugin",
  "applicationName": "Nearly"
}
```

---

### Complete Link

```bash
POST /api/auth/complete
```

**Request**

```json
{
  "payload": "...",
  "nonce": "...",
  "authToken": "..."
}
```

---

### Create Post

```bash
POST /api/posts/create
```

**Request**

```json
{
  "authToken": "...",
  "title": "...",
  "raw": "...",
  "category": 5
}
```

---

### Check Linkage

```bash
POST /api/linkage/get
```

**Request**

```json
{
  "nearAccount": "user.near"
}
```

---

## 🛠️ Discourse Configuration

**Admin → Settings → API → Allowed user API auth redirects**
Add:

```
http://localhost:3001/*
```

---

## 📄 License

**MIT**
