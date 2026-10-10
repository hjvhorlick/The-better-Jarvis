"""Device registry: one physical device, many owners, one open handle.

A device (today: the camera) is started when its first owner takes a lease and
stopped when its last owner releases it. Owners share the same frames; the device is
never opened twice. Lease changes are published to the event bus, so the diagnostics
and the agent can see who is using the camera.

  registry.register("camera", camera_service)
  lease = registry.lease("camera", "my_hands")
  lease.start(); lease.get_frame(); lease.stop()
"""
from __future__ import annotations

import threading
from typing import Any, Protocol

from .events import EventBus


class Device(Protocol):
    def start(self) -> None: ...
    def stop(self) -> None: ...
    def status(self) -> dict: ...


class DeviceLease:
    """One owner's handle on a device. Reads pass through to the device."""

    def __init__(self, registry: "DeviceRegistry", name: str, owner: str) -> None:
        self._registry = registry
        self._name = name
        self._owner = owner

    @property
    def owner(self) -> str:
        return self._owner

    def start(self) -> None:
        self._registry._acquire(self._name, self._owner)

    def stop(self) -> None:
        self._registry._release(self._name, self._owner)

    def __getattr__(self, attr: str) -> Any:            # state, get_frame, status, ...
        if attr.startswith("_"):
            raise AttributeError(attr)
        return getattr(self._registry._device(self._name), attr)


class DeviceRegistry:
    def __init__(self, bus: EventBus | None = None) -> None:
        self._bus = bus
        self._lock = threading.RLock()
        self._devices: dict[str, Device] = {}
        self._holders: dict[str, set[str]] = {}

    def register(self, name: str, device: Device) -> None:
        with self._lock:
            if name in self._devices:
                raise ValueError(f"device already registered: {name}")
            self._devices[name] = device
            self._holders[name] = set()

    def has(self, name: str) -> bool:
        with self._lock:
            return name in self._devices

    def lease(self, name: str, owner: str) -> DeviceLease:
        if not owner:
            raise ValueError("owner is required")
        self._device(name)                                # fail early on unknown names
        return DeviceLease(self, name, owner)

    def snapshot(self) -> dict:
        with self._lock:
            return {
                name: {"holders": sorted(self._holders[name]), "status": dev.status()}
                for name, dev in self._devices.items()
            }

    # ----- internals -----
    def _device(self, name: str) -> Device:
        with self._lock:
            if name not in self._devices:
                raise KeyError(f"unknown device: {name}")
            return self._devices[name]

    def _acquire(self, name: str, owner: str) -> None:
        with self._lock:
            dev = self._device(name)
            holders = self._holders[name]
            if owner in holders:
                return                                    # idempotent
            first = not holders
            if first:
                dev.start()                               # if this raises, nobody is recorded as holding it
            holders.add(owner)
            self._publish("lease_acquired", name, owner)

    def _release(self, name: str, owner: str) -> None:
        with self._lock:
            holders = self._holders.get(name)
            if holders is None or owner not in holders:
                return                                    # idempotent
            holders.discard(owner)
            if not holders:
                self._device(name).stop()
            self._publish("lease_released", name, owner)

    def _publish(self, kind: str, name: str, owner: str) -> None:
        if self._bus is not None:
            self._bus.publish("devices", {"type": kind, "device": name, "owner": owner})
