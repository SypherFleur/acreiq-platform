# AcreIQ

**AI Spatial Optimization & Resource Twin Engine**

AcreIQ scans physical growing environments, builds a structured digital twin, simulates alternative layouts and operating configurations, and recommends how to maximize output with existing assets before buying new infrastructure.

> **Optimize first. Purchase second.**

## Core loop

`SCAN → UNDERSTAND → MODEL → SIMULATE → OPTIMIZE → VISUALIZE → ACT`

## Hackathon track

Sustainability — Freestyle

## Stack

- **Frontend:** Next.js + React + TypeScript
- **Backend:** FastAPI + Python
- **AI / Vision:** Gemini multimodal models
- **Cloud:** Google Cloud / Vertex AI
- **Simulation:** Custom Python resource + spatial optimization engine

## Local development

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

## Current milestone

**Milestone 1:** polished scan-to-baseline product experience with a working simulation API.

The first demo should prove:

1. A user can upload or capture an image of a growing space.
2. AcreIQ converts the space into a structured resource inventory.
3. The simulator calculates baseline resource metrics.
4. The optimizer evaluates alternative configurations.
5. The UI displays current vs. optimized results clearly.

## Product principle

The interface is part of the product, not decoration. AcreIQ should feel trustworthy, visual, spatial, and immediate from the first screen.
