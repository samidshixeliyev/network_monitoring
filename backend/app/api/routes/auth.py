from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.security import create_access_token, verify_password
from app.db.session import get_db
from app.models import Role, User
from app.schemas.auth import LoginRequest, TokenResponse
from app.services import login_guard

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


@router.post("/login", response_model=TokenResponse)
async def login(
    body: LoginRequest, request: Request, db: AsyncSession = Depends(get_db)
) -> TokenResponse:
    ip = _client_ip(request)
    if login_guard.is_blocked(ip):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed login attempts. Try again later.",
        )

    user = await db.scalar(
        select(User)
        .options(selectinload(User.role).selectinload(Role.permissions))
        .where(User.email == body.email, User.is_active.is_(True))
    )
    if user is None or not verify_password(body.password, user.hashed_password):
        await login_guard.register_failure(ip, body.email)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
        )
    login_guard.register_success(ip)
    token = create_access_token(str(user.id))
    perms = sorted(p.name for p in user.role.permissions) if user.role else []
    return TokenResponse(
        access_token=token, email=user.email, role=user.role.name, permissions=perms
    )
