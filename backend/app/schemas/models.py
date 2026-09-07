"""Pydantic request models shared by route modules."""
from typing import Literal
from pydantic import BaseModel, Field, model_validator

class LoginRequest(BaseModel):
    username: str
    password: str



class ReportRequest(BaseModel):
    groupid: int
    item_keys: list[str] = Field(min_length=1)
    date_from: int  # unix timestamp, seconds, UTC
    date_to: int
    resolution: Literal["auto", "daily"] = "auto"



class ItemSeriesRequest(BaseModel):
    itemids: list[int] = Field(min_length=1, max_length=40)
    date_from: int
    date_to: int
    resolution: Literal["auto", "daily"] = "auto"
    # Optional wall-clock window each day (matches dashboard pivot HOURS filter)
    day_time_from: str | None = None
    day_time_to: str | None = None
    tz_offset_min: int | None = None



class PresetDef(BaseModel):
    name: str
    groupid: int
    item_keys: list[str] = Field(min_length=1)
    resolution: Literal["auto", "daily"] = "auto"
    is_shared: bool = False



class HostsItemsRequest(BaseModel):
    hostids: list[int] = Field(min_length=1)



class ItemsMetaRequest(BaseModel):
    itemids: list[int] = Field(min_length=1, max_length=500)



class DashboardColumn(BaseModel):
    id: str
    label: str
    aggregations: list[Literal["avg", "min", "max", "last"]] = Field(min_length=1)
    multiplier: float = 1
    unit: str | None = None
    decimals: int = 1
    # Legacy highlight mode (still accepted for old saved dashboards)
    color_mode: Literal["none", "bad_high", "good_high"] = "none"
    # Cell rendering: plain number, intensity bar, or both
    display: Literal["number", "bar", "number_bar", "graph", "number_graph"] = "number"
    # Configurable thresholds: mode off | high_bad | high_good
    # high_bad:  value >= red → red, >= yellow → yellow, else green
    # high_good: value <= red → red, <= yellow → yellow, else green
    thresholds: dict | None = None
    # {hostid (as string): itemid} — coerce keys/values so JSON quirks don't 422
    host_items: dict[str, int] = Field(default_factory=dict)

    class Config:
        extra = "ignore"

    @model_validator(mode="before")
    @classmethod
    def _coerce_column(cls, data):
        if not isinstance(data, dict):
            return data
        hi_in = data.get("host_items")
        if hi_in is not None:
            hi = {}
            for k, v in dict(hi_in).items():
                try:
                    hi[str(k)] = int(v)
                except (TypeError, ValueError):
                    continue
            data = {**data, "host_items": hi}
        disp = data.get("display")
        if disp not in ("number", "bar", "number_bar", "graph", "number_graph"):
            data = {**data, "display": "number"}
        return data


class DashboardDef(BaseModel):
    name: str
    hostids: list[int] = Field(min_length=1)
    columns: list[DashboardColumn] = Field(min_length=1)
    is_shared: bool = False  # share with all logged-in users
    shared_userids: list[int] = []
    shared_usrgrpids: list[int] = []


class DashboardRunRequest(BaseModel):
    date_from: int
    date_to: int
    # Optional daily time window (local HH:MM), e.g. 08:00–18:00 within the date range
    day_time_from: str | None = None
    day_time_to: str | None = None
    # JS Date.getTimezoneOffset() — minutes to add to local to get UTC
    tz_offset_min: int | None = None



class PinRequest(BaseModel):
    item_type: Literal["dashboard", "problem_dashboard"]
    item_id: str
    pinned: bool



class AdhocDashboardRun(BaseModel):
    name: str = "adhoc"
    hostids: list[int] = Field(min_length=1)
    columns: list[DashboardColumn] = Field(min_length=1)
    date_from: int
    date_to: int
    day_time_from: str | None = None
    day_time_to: str | None = None
    tz_offset_min: int | None = None



class ProblemDashDef(BaseModel):
    name: str
    hostids: list[int] = []
    groupid: int | None = None
    min_severity: int = 0
    status: str = "open"
    ack: str = "all"
    is_shared: bool = False
    shared_userids: list[int] = []
    shared_usrgrpids: list[int] = []


class ProblemsRequest(BaseModel):
    hostids: list[int] = []
    groupid: int | None = None
    min_severity: int = 0
    status: str = "open"   # open | closed | all | open_unack | open_ack
    ack: str = "all"       # all | acked | unacked
    severities: list[int] | None = None
    include_suppressed: bool = True



class ProblemActionRequest(BaseModel):
    eventids: list[int] = Field(min_length=1)
    acknowledge: bool = False
    close: bool = False
    unacknowledge: bool = False
    message: str = ""



