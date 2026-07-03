"""
Admin panel API: user + role management (permission-based access control).

Everything here requires the `manage_users` permission. Roles are named
bundles of permissions — admins can create custom roles from any permission
combination and assign them to users. Guards:
  - you cannot deactivate/delete your own account or change your own role
    (prevents locking yourself out mid-session);
  - built-in roles cannot be deleted, and the `manager` role's permissions
    cannot be edited (it is the recovery superadmin bundle);
  - a role that still has users cannot be deleted.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import require_permission
from app.core.permissions import ALL_PERMISSIONS, BUILTIN_ROLES, MANAGE_USERS
from app.db.session import get_db
from app.models import Permission, Role, User
from app.services.audit import add_audit

router = APIRouter(prefix="/api/admin", tags=["admin"])
_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")


# ── Schemas ──────────────────────────────────────────────────────────────────
class RoleRead(BaseModel):
    id: int
    name: str
    builtin: bool
    permissions: list[str]
    users: int


class RoleCreate(BaseModel):
    name: str = Field(min_length=2, max_length=50)
    permissions: list[str]


class RoleUpdate(BaseModel):
    permissions: list[str]


class UserRead(BaseModel):
    id: uuid.UUID
    email: str
    role: str
    is_active: bool


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6)
    role: str


class UserUpdate(BaseModel):
    role: str | None = None
    password: str | None = Field(default=None, min_length=6)
    is_active: bool | None = None


def _role_read(role: Role) -> RoleRead:
    return RoleRead(
        id=role.id,
        name=role.name,
        builtin=role.name in BUILTIN_ROLES,
        permissions=sorted(p.name for p in role.permissions),
        users=len(role.users),
    )


async def _load_role(db: AsyncSession, name: str) -> Role:
    role = await db.scalar(select(Role).where(Role.name == name))
    if role is None:
        raise HTTPException(status_code=400, detail=f"Unknown role: {name}")
    return role


def _validate_permissions(names: list[str]) -> list[str]:
    unknown = set(names) - set(ALL_PERMISSIONS)
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown permissions: {', '.join(sorted(unknown))}")
    return sorted(set(names))


# ── Permissions / roles ──────────────────────────────────────────────────────
@router.get("/permissions")
async def list_permissions(
    _: User = Depends(require_permission(MANAGE_USERS)),
) -> list[str]:
    return ALL_PERMISSIONS


@router.get("/roles", response_model=list[RoleRead])
async def list_roles(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission(MANAGE_USERS)),
) -> list[RoleRead]:
    roles = (
        await db.scalars(
            select(Role)
            .options(selectinload(Role.permissions), selectinload(Role.users))
            .order_by(Role.id)
        )
    ).all()
    return [_role_read(r) for r in roles]


@router.post("/roles", response_model=RoleRead, status_code=status.HTTP_201_CREATED)
async def create_role(
    body: RoleCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(MANAGE_USERS)),
) -> RoleRead:
    perm_names = _validate_permissions(body.permissions)
    if await db.scalar(select(Role).where(Role.name == body.name)):
        raise HTTPException(status_code=409, detail="A role with this name already exists")
    perms = (await db.scalars(select(Permission).where(Permission.name.in_(perm_names)))).all()
    role = Role(name=body.name, permissions=list(perms))
    db.add(role)
    add_audit(
        db, current_user, "role.create",
        target_type="role", detail=f"{body.name}: {', '.join(perm_names)}",
    )
    await db.commit()
    role = await db.scalar(
        select(Role)
        .options(selectinload(Role.permissions), selectinload(Role.users))
        .where(Role.id == role.id)
    )
    return _role_read(role)


@router.patch("/roles/{role_id}", response_model=RoleRead)
async def update_role(
    role_id: int,
    body: RoleUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(MANAGE_USERS)),
) -> RoleRead:
    role = await db.scalar(
        select(Role)
        .options(selectinload(Role.permissions), selectinload(Role.users))
        .where(Role.id == role_id)
    )
    if role is None:
        raise HTTPException(status_code=404, detail="Role not found")
    if role.name == "manager":
        raise HTTPException(status_code=400, detail="The manager role's permissions cannot be edited")
    perm_names = _validate_permissions(body.permissions)
    perms = (await db.scalars(select(Permission).where(Permission.name.in_(perm_names)))).all()
    role.permissions = list(perms)
    add_audit(
        db, current_user, "role.update",
        target_type="role", target_id=str(role_id),
        detail=f"{role.name}: {', '.join(perm_names) or '(none)'}",
    )
    await db.commit()
    await db.refresh(role)
    return _role_read(role)


@router.delete("/roles/{role_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_role(
    role_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(MANAGE_USERS)),
) -> None:
    role = await db.scalar(
        select(Role).options(selectinload(Role.users)).where(Role.id == role_id)
    )
    if role is None:
        raise HTTPException(status_code=404, detail="Role not found")
    if role.name in BUILTIN_ROLES:
        raise HTTPException(status_code=400, detail="Built-in roles cannot be deleted")
    if role.users:
        raise HTTPException(status_code=400, detail="Role still has users assigned")
    add_audit(db, current_user, "role.delete", target_type="role", detail=role.name)
    await db.delete(role)
    await db.commit()


# ── Users ────────────────────────────────────────────────────────────────────
@router.get("/users", response_model=list[UserRead])
async def list_users(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_permission(MANAGE_USERS)),
) -> list[UserRead]:
    users = (
        await db.scalars(
            select(User).options(selectinload(User.role)).order_by(User.created_at)
        )
    ).all()
    return [
        UserRead(id=u.id, email=u.email, role=u.role.name if u.role else "", is_active=u.is_active)
        for u in users
    ]


@router.post("/users", response_model=UserRead, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: UserCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(MANAGE_USERS)),
) -> UserRead:
    if await db.scalar(select(User).where(User.email == body.email)):
        raise HTTPException(status_code=409, detail="A user with this email already exists")
    role = await _load_role(db, body.role)
    user = User(email=body.email, hashed_password=_pwd.hash(body.password), role_id=role.id)
    db.add(user)
    add_audit(
        db, current_user, "user.create",
        target_type="user", detail=f"{body.email} ({role.name})",
    )
    await db.commit()
    await db.refresh(user)
    return UserRead(id=user.id, email=user.email, role=role.name, is_active=user.is_active)


@router.patch("/users/{user_id}", response_model=UserRead)
async def update_user(
    user_id: uuid.UUID,
    body: UserUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(MANAGE_USERS)),
) -> UserRead:
    user = await db.scalar(
        select(User).options(selectinload(User.role)).where(User.id == user_id)
    )
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    changes: list[str] = []
    if body.role is not None:
        if user.id == current_user.id:
            raise HTTPException(status_code=400, detail="You cannot change your own role")
        role = await _load_role(db, body.role)
        user.role_id = role.id
        user.role = role
        changes.append(f"role→{role.name}")
    if body.is_active is not None:
        if user.id == current_user.id:
            raise HTTPException(status_code=400, detail="You cannot deactivate your own account")
        user.is_active = body.is_active
        changes.append("activated" if body.is_active else "deactivated")
    if body.password:
        user.hashed_password = _pwd.hash(body.password)
        changes.append("password")

    add_audit(
        db, current_user, "user.update",
        target_type="user", target_id=str(user_id),
        detail=f"{user.email}: {', '.join(changes) or '(no fields)'}",
    )
    await db.commit()
    await db.refresh(user)
    return UserRead(
        id=user.id, email=user.email,
        role=user.role.name if user.role else "", is_active=user.is_active,
    )


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(MANAGE_USERS)),
) -> None:
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    devices_count = await db.scalar(
        select(func.count()).select_from(User.__table__.metadata.tables["devices"]).where(
            User.__table__.metadata.tables["devices"].c.created_by == user_id
        )
    )
    if devices_count:
        # Devices keep a NOT NULL created_by FK — deactivate instead of delete.
        raise HTTPException(
            status_code=400,
            detail="User owns devices — deactivate the account instead of deleting it",
        )
    add_audit(db, current_user, "user.delete", target_type="user", detail=user.email)
    await db.delete(user)
    await db.commit()
