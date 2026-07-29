from sqlalchemy import Column, Integer, BigInteger, String, Boolean, DateTime, Numeric
from sqlalchemy.sql import func
from database import Base

class SensorData(Base):
    __tablename__ = "rawlog"
    __table_args__ = {"schema": "suhu"}

    id             = Column(Integer, primary_key=True, index=True)
    codename       = Column(String)
    codenumber     = Column(String)
    temperature    = Column(Numeric)
    limit_low_temp = Column(Numeric)
    limit_high_temp= Column(Numeric)
    setpoint       = Column(Numeric)
    power          = Column(Integer)
    mode           = Column(String)
    power_status   = Column(String)
    status         = Column(String)
    rssi           = Column(Integer)
    esp_millis     = Column(BigInteger)
    created_at     = Column(DateTime(timezone=True))

class UserSubscription(Base):
    __tablename__ = "telegram_subscriptions"

    id            = Column(Integer, primary_key=True, index=True)
    chat_id       = Column(BigInteger, unique=True, nullable=False)
    codename      = Column(String(50), nullable=False)
    username      = Column(String(100))
    first_name    = Column(String(100))
    last_name     = Column(String(100))
    is_active     = Column(Boolean, default=True)
    subscribed_at = Column(DateTime(timezone=True), default=func.now())

class FeederRawlog(Base):
    __tablename__ = "rawlog"
    __table_args__ = {"schema": "feeder"}

    id                = Column(Integer, primary_key=True, index=True)
    publish_type      = Column(String)
    codename          = Column(String)
    codenumber        = Column(Integer)
    jenis_pakan       = Column(String)
    target_gram       = Column(Numeric)
    aktual_gram       = Column(Numeric)
    out_gram          = Column(Numeric)
    status_pakan      = Column(String)
    waktu_pakan       = Column(DateTime(timezone=True))
    status_stok       = Column(String)
    jarak_ultrasonik  = Column(Numeric)
    status            = Column(String)
    rssi              = Column(Integer)
    esp_millis        = Column(BigInteger)
    created_at        = Column(DateTime(timezone=True))

class FeederStatusLatest(Base):
    __tablename__ = "status_latest"
    __table_args__ = {"schema": "feeder"}

    id                = Column(Integer, primary_key=True, index=True)
    codename          = Column(String)
    codenumber        = Column(Integer)
    status_stok       = Column(String)
    jarak_ultrasonik  = Column(Numeric)
    status            = Column(String)
    rssi              = Column(Integer)
    updated_at        = Column(DateTime(timezone=True))