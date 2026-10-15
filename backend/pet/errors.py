"""对外错误保持中文，不暴露上游堆栈或凭据。"""

class ServiceError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message, self.status = message, status
