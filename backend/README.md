# Django chat backend

## Setup

From the repository root, install the backend dependencies:

```powershell
python -m pip install -r backend/requirements.txt
Copy-Item backend/.env.example backend/.env
npm --prefix frontend ci
```

Edit `backend/.env` and set `GEMINI_API_KEY` to your key from Google AI Studio. Keep this file private; it is ignored by Git. The default model is `gemini-3.5-flash-lite`, a lightweight model for faster responses.

Start the backend in one terminal:

```powershell
python backend/manage.py migrate
python backend/manage.py runserver 127.0.0.1:8000
```

In a second terminal, start the frontend:

```powershell
npm --prefix frontend run dev
```

Open the local URL printed by Vite (usually `http://localhost:5173`). Keep both terminals running while chatting. Vite proxies `/api` requests to Django, so the Gemini key never enters the browser bundle. If a Gemini request fails, check the Django terminal for the detailed server-side error.

The chat endpoint accepts a `messages` array of `{ "role": "user" | "assistant", "content": "..." }` and returns `{ "reply": "..." }`. Requests are stateless at Google (`store=False`); the browser sends the current conversation history each turn.
