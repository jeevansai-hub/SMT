"""Identity use cases and ports."""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Callable, Optional, Protocol

from identity.domain.model import (
    EmailUnavailable,
    InvalidCredentials,
    InvalidInput,
    TooManyAttempts,
    User,
    check_password,
    check_role,
    check_track,
    clean_display_name,
    normalise_email,
)


class PasswordHasher(Protocol):
    def hash(self, password: str) -> str: ...
    def verify(self, password: str, stored: str) -> bool: ...


class UserRepository(Protocol):
    def add(self, user: User, password_hash: str, now: datetime) -> bool: ...
    def by_email(self, email: str) -> Optional[tuple[User, str]]: ...
    def by_id(self, user_id: str) -> Optional[User]: ...
    def by_alias(self, alias: str) -> Optional[User]: ...
    def set_track(self, user_id: str, track: str) -> None: ...


class SessionRepository(Protocol):
    def create(self, token_hash: str, user_id: str, expires_at: datetime, now: datetime) -> None: ...
    def user_id_for(self, token_hash: str, now: datetime) -> Optional[str]: ...
    def delete(self, token_hash: str) -> None: ...


MAX_FAILURES = 5
LOCK_WINDOW = timedelta(minutes=5)


class IdentityService:
    def __init__(
        self,
        users: UserRepository,
        sessions: SessionRepository,
        hasher: PasswordHasher,
        clock: Callable[[], datetime],
        session_ttl_seconds: int = 8 * 3600,
    ) -> None:
        self._users = users
        self._sessions = sessions
        self._hasher = hasher
        self._clock = clock
        self._ttl = timedelta(seconds=session_ttl_seconds)
        self._failures: dict[str, tuple[int, datetime]] = {}
        self._dummy = hasher.hash("not-a-real-password")

    @property
    def session_ttl_seconds(self) -> int:
        return int(self._ttl.total_seconds())

    # --- account creation (role is only ever set here, server-side) -------
    def create_user(self, email: str, password: str, role: str = "learner",
                    display_name: Optional[str] = None, track: Optional[str] = None) -> User:
        email = normalise_email(email)
        check_password(password)
        check_role(role)
        check_track(track)
        prefix = "lrn_" if role == "learner" else "usr_"
        user = User(
            id=prefix + secrets.token_hex(8),
            alias="cnd_" + secrets.token_hex(6),
            role=role,
            track=track,
            email=email,
            display_name=clean_display_name(display_name),
        )
        if not self._users.add(user, self._hasher.hash(password), self._clock()):
            raise EmailUnavailable("email")
        return user

    def register_learner(self, email: str, password: str, display_name: Optional[str]) -> User:
        return self.create_user(email, password, "learner", display_name)

    # --- sessions ------------------------------------------------------------
    def login(self, email: str, password: str) -> tuple[User, str]:
        now = self._clock()
        try:
            key = normalise_email(email)
        except InvalidInput:
            self._hasher.verify(password or "", self._dummy)
            raise InvalidCredentials("credentials")
        count, since = self._failures.get(key, (0, now))
        if now - since > LOCK_WINDOW:
            count, since = 0, now
        if count >= MAX_FAILURES:
            raise TooManyAttempts("locked")
        found = self._users.by_email(key)
        stored = found[1] if found else self._dummy
        ok = self._hasher.verify(password or "", stored)
        if not found or not ok:
            self._failures[key] = (count + 1, since)
            raise InvalidCredentials("credentials")
        self._failures.pop(key, None)
        token = secrets.token_urlsafe(32)
        self._sessions.create(self._digest(token), found[0].id, now + self._ttl, now)
        return found[0], token

    def create_session_for_user(self, user: User) -> str:
        now = self._clock()
        token = secrets.token_urlsafe(32)
        self._sessions.create(self._digest(token), user.id, now + self._ttl, now)
        return token

    def logout(self, token: Optional[str]) -> None:
        if token:
            self._sessions.delete(self._digest(token))

    def user_for_token(self, token: Optional[str]) -> Optional[User]:
        if not token:
            return None
        user_id = self._sessions.user_id_for(self._digest(token), self._clock())
        return self._users.by_id(user_id) if user_id else None

    # --- profile ---------------------------------------------------------------
    def set_track(self, user_id: str, track: str) -> None:
        check_track(track)
        if track is None:
            raise InvalidInput("track")
        self._users.set_track(user_id, track)

    def alias_for(self, learner_id: str) -> Optional[str]:
        user = self._users.by_id(learner_id)
        return user.alias if user else None

    def learner_for_alias(self, alias: str) -> Optional[str]:
        user = self._users.by_alias(alias)
        return user.id if user and user.role == "learner" else None

    def get(self, user_id: str) -> Optional[User]:
        return self._users.by_id(user_id)

    @staticmethod
    def _digest(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()
