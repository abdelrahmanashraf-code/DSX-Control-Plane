from dsx_control_plane.settings import get_settings
from fastapi import FastAPI


settings = get_settings()

app = FastAPI(
    title="DSX Control Plane API",
    version="0.1.0",
    docs_url="/docs" if settings.env != "production" else None,
    redoc_url=None,
)


@app.get("/healthz", tags=["system"])
async def healthz() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "dsx-control-plane-api",
        "environment": settings.env,
    }
