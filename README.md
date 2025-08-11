# AI-Travel-Itinerary
A serverless application that generates travel itineraries using OpenAI via a Cloudflare Worker, with async processing and Firestore persistence. 

## 🧩 Features

- Full end-to-end flow: User → Cloudflare Worker → OpenAI → Firestore
- Async processing with `202 Accepted` and background job
- Structured JSON itinerary stored in Firestore
- Job ID tracking
- Retry logic with exponential backoff on LLM failures

## 🛠️ Tech Stack

- **Database**: Google Cloud Firestore (in Datastore mode or Native mode)
- **LLM**: OpenAI API (e.g., `gpt-3.5-turbo` or `gpt-4`)
- **Hosting**: 
  - Backend: Cloudflare Workers
- **Auth**: Service Account Key for Firestore

## 📦 Prerequisites

Before getting started, ensure you have:

- [x] A [Cloudflare Account](https://dash.cloudflare.com)
- [x] A [Google Cloud Project](https://console.cloud.google.com/) with Firestore enabled
- [x] An [OpenAI API key](https://platform.openai.com/api-keys)
- [x] `npm` / `node` installed (v18+)
- [x] Wrangler CLI: `npm install -g wrangler`
- [x] Firebase Admin SDK access (via service account JSON key)

## 🔑 Environment Variables(secrets)
### Cloudflare Worker (set via Wrangler)

```bash
OPENAI_API_KEY="sk-..."
FIRESTORE_PROJECT_ID="your-gcp-project-id"
FIRESTORE_KEY="Your-gcp-service-account-key.json"

project-root/
├── cf-travel-itinerary/               # Cloudflare Worker + handlers
│   ├── src/
│   │   └── index.js                   # Main worker logic
│   └── wrangler.toml
│   └── gcp-service-account-key.json   # You should create yourself
│   └── package.json
│   └── package-lock.json
│   └── nod_modules/                   # You should install yourself in the same directory/```bash
│   └── wrangler/                      # You should install yourself in the same directory/```bash
└── README.md

