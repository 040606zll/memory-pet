"""统一接口响应，错误消息只承载可展示的中文提示。"""


def response(data=None, message="成功", code=0):
    return {"code": code, "message": message, "data": data}
