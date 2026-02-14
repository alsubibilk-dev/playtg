# main.py
from fastapi import FastAPI, Request, Response, Header, Cookie
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
import structlog
import logging
import httpx
import json

from config import settings
from database import init_db
from auth import validate_init_data, create_tokens, get_current_user
from routes.collections import router as collections_router
from routes.inventory import router as inventory_router
from routes.market import router as market_router
from routes.leaderboard import router as leaderboard_router
from routes.daily import router as daily_router

app = FastAPI(title="ChaosMeme Hub Backend")

structlog.configure(
    processors=[structlog.processors.JSONRenderer()]
)
logging.basicConfig(level=logging.INFO)

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter

app.add_exception_handler(RateLimitExceeded, lambda req, exc: {"detail": "Rate limit exceeded", "status": 429})

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # В продакшене замени на реальные домены Telegram Mini App
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(collections_router)
app.include_router(inventory_router)
app.include_router(market_router)
app.include_router(leaderboard_router)
app.include_router(daily_router)


@app.on_event("startup")
async def startup_event():
    try:
        await init_db()
        logging.info("Таблицы базы данных созданы или проверены")
    except Exception as e:
        logging.error(f"Ошибка инициализации базы данных: {e}")
        # можно добавить raise RuntimeError("Не удалось инициализировать БД"), если хочешь, чтобы приложение не запускалось при ошибке БД

    # Если webhook не нужен локально — закомментируй этот блок
    # webhook_url = "https://your-domain.com/webhook"
    # async with httpx.AsyncClient() as client:
    #     try:
    #         r = await client.post(
    #             f"https://api.telegram.org/bot{settings.telegram_bot_token}/setWebhook",
    #             json={"url": webhook_url}
    #         )
    #         r.raise_for_status()
    #         logging.info("Webhook Telegram успешно установлен")
    #     except Exception as e:
    #         logging.warning(f"Не удалось установить webhook: {e}")


@app.post("/webhook")
async def bot_webhook(update: dict):
    if 'pre_checkout_query' in update:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"https://api.telegram.org/bot{settings.telegram_bot_token}/answerPreCheckoutQuery",
                json={
                    "pre_checkout_query_id": update['pre_checkout_query']['id'],
                    "ok": True
                }
            )
    if 'message' in update and 'successful_payment' in update.get('message', {}):
        payload_str = update['message']['successful_payment'].get('invoice_payload')
        if payload_str:
            try:
                payload = json.loads(payload_str)
                market_id = payload.get('market_id')
                buyer_id = payload.get('buyer_id')
                if market_id and buyer_id:
                    from routes.market import process_buy_after_payment
                    await process_buy_after_payment(market_id, buyer_id)
            except Exception as e:
                logging.error(f"Ошибка обработки платежа в webhook: {e}")
    return {"ok": True}


@app.post("/auth/verify")
async def auth_verify(response: Response, init_data: str = Header(None, alias="X-Telegram-Init-Data")):
    try:
        user_id = validate_init_data(init_data)
        access, refresh = create_tokens(user_id)
        secure_cookie = False  # в локальной разработке secure=False
        response.set_cookie(
            key="access_token",
            value=access,
            httponly=True,
            secure=secure_cookie,
            samesite="lax",
            max_age=settings.jwt_access_minutes * 60
        )
        response.set_cookie(
            key="refresh_token",
            value=refresh,
            httponly=True,
            secure=secure_cookie,
            samesite="lax",
            max_age=settings.jwt_refresh_days * 86400
        )
        return {"status": "authenticated", "user_id": user_id}
    except Exception as e:
        logging.error(f"Ошибка верификации: {e}")
        raise HTTPException(status_code=401, detail="Authentication failed")


@app.get("/health")
async def health():
    return {"status": "healthy"}  # убрали settings.app_env, чтобы не падало


@app.get("/test")
async def test():
    return {"message": "Сервер работает нормально"}