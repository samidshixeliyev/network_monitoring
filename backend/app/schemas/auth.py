from pydantic import BaseModel, EmailStr


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    email: str
    role: str
    # Permission names granted by the role; the frontend uses these to hide
    # controls. The backend remains the authoritative gate regardless.
    permissions: list[str] = []
