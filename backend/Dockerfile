# SkyRoute Warsaw backend (FastAPI). Build context: the repository root (needs backend/ and data/).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    # Simulated fleet state lives in a volume, not in the image.
    SKYROUTE_FLEET_DB=/app/state/fleet.sqlite \
    # The saved Open Data Warsaw snapshot survives restarts (re-fetched every 24 h).
    SKYROUTE_CITY_WEATHER_FILE=/app/state/city_weather.json

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install -r backend/requirements.txt

# app/config.py resolves the data folder as <repo root>/data, i.e. /app/data here.
COPY backend/app backend/app
COPY data data
RUN mkdir -p /app/state

WORKDIR /app/backend
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=12 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=4)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
