#----------------------------------- main.py -----------------------------------#
from fastapi import FastAPI, Depends, Request, HTTPException
from sqlalchemy.orm import Session
import models
import schemas
from database import SessionLocal, engine, get_db

models.Base.metadata.create_all(bind=engine)
app= FastAPI(root_path="/telegram")

@app.post("/users")
def create_user(user: schemas.CreateUser, db: Session = Depends(get_db)):
    existing = db.query(models.User).filter(
        models.User.username == user.username
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Nama sudah digunakan")
    
    existing = db.query(models.User).filter(
        models.User.email == user.email
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email sudah digunakan")
    
    new_user = models.User(
        username=user.username,
        email=user.email
    )

    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return {"message": "User berhasil didaftarkan", "user_id": new_user.id}

@app.get("/users")
def get_users(db: Session = Depends(get_db)):
    return db.query(models.User).all()

@app.delete("/users/{user_id}")
def delete_user(user_id: int, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User tidak ditemukan")
    db.delete(user)
    db.commit()
    return {"message": "User berhasil dihapus"}

@app.get("/telegram")
def root():
    return {"status": "FastAPI OK"}