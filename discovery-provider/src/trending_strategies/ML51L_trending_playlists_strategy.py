from src.trending_strategies.base_trending_strategy import BaseTrendingStrategy
from src.trending_strategies.ML51L_trending_tracks_strategy import z
from src.trending_strategies.trending_type_and_version import (
    TrendingType,
    TrendingVersion,
)


class TrendingPlaylistsStrategyML51L(BaseTrendingStrategy):
    def __init__(self):
        super().__init__(TrendingType.PLAYLISTS, TrendingVersion.ML51L)

    def get_track_score(self, time_range, track):
        return z(time_range, track)

    def get_score_params(self):
        return {"zq": 1000, "xf": True, "pt": 0, "mt": 3}
