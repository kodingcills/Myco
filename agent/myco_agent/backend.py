import abc
import sys


class OpsBackend(abc.ABC):
    @abc.abstractmethod
    def ping(self):
        ...

    @abc.abstractmethod
    def session_info(self):
        ...

    @abc.abstractmethod
    def launch(self, argv, cwd=None):
        ...

    @abc.abstractmethod
    def uia_tree(self, pid=None, title=None, depth=8):
        ...

    @abc.abstractmethod
    def uia_invoke(self, runtime_id, action, value=None):
        ...

    @abc.abstractmethod
    def screenshot(self, pid=None, rect=None):
        ...

    @abc.abstractmethod
    def read_file(self, path):
        ...

    @abc.abstractmethod
    def write_file(self, path, data):
        ...

    @abc.abstractmethod
    def kill(self, pid=None, image_name=None):
        ...

    @abc.abstractmethod
    def uno_eval(self, call, sheet=None, cell=None, socket=None):
        ...


def select_backend(name=None):
    if name is None:
        name = "windows" if sys.platform == "win32" else "fake"
    if name == "windows":
        from myco_agent.windows_backend import WindowsBackend
        return WindowsBackend()
    if name == "fake":
        from myco_agent.fake_backend import FakeBackend
        return FakeBackend()
    raise ValueError(f"unknown backend: {name!r}")
