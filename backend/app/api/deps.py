import uuid

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.security import decode_token
from app.db.session import get_db
from app.models import User

_bearer = HTTPBearer()


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = decode_token(credentials.credentials)
        user_id = uuid.UUID(payload["sub"])
    except (ValueError, KeyError):
        raise exc

    user = await db.scalar(
        select(User)
        .options(selectinload(User.role))
        .where(User.id == user_id, User.is_active == True)  # noqa: E712 (MSSQL needs `= 1`, not `IS 1`)
    )
    if user is None:
        raise exc
    return user


def require_role(*roles: str):
    async def dependency(current_user: User = Depends(get_current_user)) -> User:
        if current_user.role.name not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions",
            )
        return current_user

    return dependency
