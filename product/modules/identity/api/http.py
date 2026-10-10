"""HTTP surface: /auth/*, /me, /me/track and the auth dependencies."""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from identity.api import runtime
from identity.api.dto import User
from identity.domain.model import (
    EmailUnavailable,
    InvalidCredentials,
    InvalidInput,
    TooManyAttempts,
)

log = logging.getLogger("identity")
router = APIRouter()


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _to_dto(u) -> User:
    return User(id=u.id, alias=u.alias, role=u.role, track=u.track)


def current_user(request: Request) -> User:
    """FastAPI dependency: the authenticated user or 401."""
    user = runtime.service().user_for_token(request.cookies.get(runtime.COOKIE_NAME))
    if user is None:
        raise _err(401, "unauthenticated", "Authentication required")
    return _to_dto(user)


def require_role(*roles: str):
    allowed = frozenset(roles)

    def dependency(user: User = Depends(current_user)) -> User:
        if user.role not in allowed:
            raise _err(403, "forbidden", "Not permitted")
        return user

    return dependency


class RegisterBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(max_length=254)
    password: str = Field(min_length=10, max_length=128)
    display_name: Optional[str] = Field(default=None, max_length=80)


class LoginBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(max_length=254)
    password: str = Field(max_length=128)


class TrackBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    track: str = Field(pattern="^(python|data_analyst)$")


def _set_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        runtime.COOKIE_NAME, token, max_age=runtime.service().session_ttl_seconds,
        httponly=True, samesite="strict", secure=runtime.cookie_secure(), path="/",
    )


def _me(user) -> dict:
    return {"id": user.id, "alias": user.alias, "role": user.role, "track": user.track,
            "email": user.email, "display_name": user.display_name}


@router.post("/auth/register", status_code=201)
def register(body: RegisterBody, response: Response):
    svc = runtime.service()
    try:
        user = svc.register_learner(body.email, body.password, body.display_name)
        _, token = svc.login(body.email, body.password)
    except InvalidInput:
        raise _err(422, "invalid_input", "Invalid input")
    except EmailUnavailable:
        raise _err(409, "email_unavailable", "That email cannot be used")
    _set_cookie(response, token)
    log.info("learner_registered", extra={"event": "learner_registered", "user": user.alias})
    return _me(user)


@router.post("/auth/login")
def login(body: LoginBody, response: Response):
    try:
        user, token = runtime.service().login(body.email, body.password)
    except TooManyAttempts:
        raise _err(429, "too_many_attempts", "Too many attempts; try again later")
    except InvalidCredentials:
        raise _err(401, "invalid_credentials", "Invalid credentials")
    _set_cookie(response, token)
    return _me(user)


@router.post("/auth/logout")
def logout(request: Request, response: Response):
    runtime.service().logout(request.cookies.get(runtime.COOKIE_NAME))
    response.delete_cookie(runtime.COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/me")
def me(user: User = Depends(current_user)):
    full = runtime.service().get(user.id)
    return _me(full)


@router.put("/me/track")
def set_track(body: TrackBody, user: User = Depends(current_user)):
    if user.role != "learner":
        raise _err(403, "forbidden", "Not permitted")
    runtime.service().set_track(user.id, body.track)
    return {"track": body.track}


@router.get("/auth/demo-session")
def demo_session(role: str = "learner", track: str = "python", redirect: Optional[str] = None):
    from fastapi.responses import RedirectResponse
    svc = runtime.service()
    
    # normalize role
    role_norm = role.lower().strip()
    if role_norm in ("admitter", "audit", "auditor"):
        resolved_role = "auditor"
    elif role_norm in ("hr", "recruiter"):
        resolved_role = "recruiter"
    elif role_norm in ("review", "reviewer"):
        resolved_role = "reviewer"
    else:
        resolved_role = "learner"

    email = f"demo-{resolved_role}@crucible.example"
    display = f"Demo {resolved_role.capitalize()}"
    
    default_redirects = {
        "learner": f"/lobby/1?track={track}",
        "recruiter": "/hr",
        "auditor": "/audit",
        "reviewer": "/review",
    }
    target = redirect or default_redirects.get(resolved_role, "/path")

    user = None
    try:
        found = svc._users.by_email(email)
        if found:
            user = found[0]
            if resolved_role == "learner" and track in ("python", "data_analyst") and user.track != track:
                svc.set_track(user.id, track)
                user = svc.get(user.id)
    except Exception:
        pass
    if user is None:
        try:
            user = svc.create_user(
                email, "DemoPassword123!",
                role=resolved_role,
                display_name=display,
                track=track if resolved_role == "learner" else None,
            )
        except Exception:
            user = svc._users.by_email(email)[0]
    token = svc.create_session_for_user(user)
    resp = RedirectResponse(url=target, status_code=303)
    resp.set_cookie(
        runtime.COOKIE_NAME, token, max_age=svc.session_ttl_seconds,
        httponly=True, samesite="lax", secure=runtime.cookie_secure(), path="/",
    )
    return resp
