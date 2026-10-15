"""本地服务启动入口，固定本机监听。"""
import uvicorn

if __name__ == "__main__":
    uvicorn.run("pet.main:app", host="127.0.0.1", port=8797, access_log=False)
