import logging
import time
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm.session import Session
from src.models import Block
from src.tasks.celery_app import celery
from src.utils.update_indexing_checkpoints import (
    get_last_indexed_checkpoint,
    save_indexed_checkpoint,
)

logger = logging.getLogger(__name__)

# Names of the aggregate tables to update
AGGREGATE_USER = "aggregate_user"
DEFAULT_UPDATE_TIMEOUT = 60 * 30  # 30 minutes

# UPDATE_AGGREGATE_USER_QUERY
# Get a lower bound blocknumber to check for new entity counts for a user
# Find a subset of users that have changed since that blocknumber
# For that subset of users reclaculate the entire counts for each entity
# Insert that count for new users or update it to an existing row
UPDATE_AGGREGATE_USER_QUERY = """
        WITH aggregate_user_latest_blocknumber AS (
            SELECT
                :most_recent_indexed_aggregate_block AS blocknumber
        ),
        changed_users AS (
            SELECT
                user_id
            FROM
                users u
            WHERE
                u.is_current IS TRUE
                AND u.blocknumber > (
                    SELECT
                        blocknumber
                    FROM
                        aggregate_user_latest_blocknumber
                )
            GROUP BY
                user_id
            UNION
            ALL
            SELECT
                t.owner_id AS owner_id
            FROM
                tracks t
            WHERE
                t.is_current IS TRUE
                AND t.blocknumber > (
                    SELECT
                        blocknumber
                    FROM
                        aggregate_user_latest_blocknumber
                )
            GROUP BY
                t.owner_id
            UNION
            ALL
            SELECT
                p.playlist_owner_id AS owner_id
            FROM
                playlists p
            WHERE
                p.is_album IS FALSE
                AND p.is_current IS TRUE
                AND p.blocknumber > (
                    SELECT
                        blocknumber
                    FROM
                        aggregate_user_latest_blocknumber
                )
            GROUP BY
                p.playlist_owner_id
            UNION
            ALL
            SELECT
                p.playlist_owner_id AS owner_id
            FROM
                playlists p
            WHERE
                p.is_album IS TRUE
                AND p.is_current IS TRUE
                AND p.blocknumber > (
                    SELECT
                        blocknumber
                    FROM
                        aggregate_user_latest_blocknumber
                )
            GROUP BY
                p.playlist_owner_id
            UNION
            ALL (
                SELECT
                    f.followee_user_id AS followee_user_id
                FROM
                    follows f
                WHERE
                    f.is_current IS TRUE
                    AND f.blocknumber > (
                        SELECT
                            blocknumber
                        FROM
                            aggregate_user_latest_blocknumber
                    )
                GROUP BY
                    f.followee_user_id
            )
            UNION
            ALL (
                SELECT
                    f.follower_user_id AS follower_user_id
                FROM
                    follows f
                WHERE
                    f.is_current IS TRUE
                    AND f.blocknumber > (
                        SELECT
                            blocknumber
                        from
                            aggregate_user_latest_blocknumber
                    )
                GROUP BY
                    f.follower_user_id
            )
            UNION
            ALL (
                SELECT
                    r.user_id AS user_id
                FROM
                    reposts r
                WHERE
                    r.is_current IS TRUE
                    AND r.blocknumber > (
                        SELECT
                            blocknumber
                        from
                            aggregate_user_latest_blocknumber
                    )
                GROUP BY
                    r.user_id
            )
            UNION
            ALL (
                SELECT
                    s.user_id AS user_id
                FROM
                    saves s
                WHERE
                    s.is_current IS TRUE
                    AND s.save_type = 'track'
                    AND s.blocknumber > (
                        SELECT
                            blocknumber
                        FROM
                            aggregate_user_latest_blocknumber
                    )
                GROUP BY
                    s.user_id
            )
        )
        INSERT INTO
            aggregate_user (
                user_id,
                track_count,
                playlist_count,
                album_count,
                follower_count,
                following_count,
                repost_count,
                track_save_count
            )
        SELECT
            DISTINCT(u.user_id),
            COALESCE (user_track.track_count, 0) AS track_count,
            COALESCE (user_playlist.playlist_count, 0) AS playlist_count,
            COALESCE (user_album.album_count, 0) AS album_count,
            COALESCE (user_follower.follower_count, 0) AS follower_count,
            COALESCE (user_followee.followee_count, 0) AS following_count,
            COALESCE (user_repost.repost_count, 0) AS repost_count,
            COALESCE (user_track_save.save_count, 0) AS track_save_count
        FROM
            users u
            LEFT OUTER JOIN (
                SELECT
                    t.owner_id AS owner_id,
                    count(t.owner_id) AS track_count
                FROM
                    tracks t
                WHERE
                    t.is_current IS TRUE
                    AND t.is_delete IS FALSE
                    AND t.is_unlisted IS FALSE
                    AND t.stem_of IS NULL
                    AND t.owner_id IN (
                        select
                            user_id
                        from
                            changed_users
                    )
                GROUP BY
                    t.owner_id
            ) as user_track ON user_track.owner_id = u.user_id
            LEFT OUTER JOIN (
                SELECT
                    p.playlist_owner_id AS owner_id,
                    count(p.playlist_owner_id) AS playlist_count
                FROM
                    playlists p
                WHERE
                    p.is_album IS FALSE
                    AND p.is_current IS TRUE
                    AND p.is_delete IS FALSE
                    AND p.is_private IS FALSE
                    AND p.playlist_owner_id IN (
                        select
                            user_id
                        from
                            changed_users
                    )
                GROUP BY
                    p.playlist_owner_id
            ) AS user_playlist ON user_playlist.owner_id = u.user_id
            LEFT OUTER JOIN (
                SELECT
                    p.playlist_owner_id AS owner_id,
                    count(p.playlist_owner_id) AS album_count
                FROM
                    playlists p
                WHERE
                    p.is_album IS TRUE
                    AND p.is_current IS TRUE
                    AND p.is_delete IS FALSE
                    AND p.is_private IS FALSE
                    AND p.playlist_owner_id IN (
                        SELECT
                            user_id
                        FROM
                            changed_users
                    )
                GROUP BY
                    p.playlist_owner_id
            ) user_album ON user_album.owner_id = u.user_id
            LEFT OUTER JOIN (
                SELECT
                    f.followee_user_id AS followee_user_id,
                    count(f.followee_user_id) AS follower_count
                FROM
                    follows f
                WHERE
                    f.is_current IS TRUE
                    AND f.is_delete IS FALSE
                    AND f.followee_user_id IN ( -- to calculate follower count for changed users, changed user id must match followee user id
                        SELECT
                            user_id
                        FROM
                            changed_users
                    )
                GROUP BY
                    f.followee_user_id
            ) user_follower ON user_follower.followee_user_id = u.user_id
            LEFT OUTER JOIN (
                SELECT
                    f.follower_user_id AS follower_user_id,
                    count(f.follower_user_id) AS followee_count
                FROM
                    follows f
                WHERE
                    f.is_current IS TRUE
                    AND f.is_delete IS FALSE
                    AND f.follower_user_id IN (
                        SELECT
                            user_id
                        FROM
                            changed_users
                    )
                GROUP BY
                    f.follower_user_id
            ) user_followee ON user_followee.follower_user_id = u.user_id
            LEFT OUTER JOIN (
                SELECT
                    r.user_id AS user_id,
                    count(r.user_id) AS repost_count
                FROM
                    reposts r
                WHERE
                    r.is_current IS TRUE
                    AND r.is_delete IS FALSE
                    AND r.user_id IN (
                        SELECT
                            user_id
                        from
                            changed_users
                    )
                GROUP BY
                    r.user_id
            ) user_repost ON user_repost.user_id = u.user_id
            LEFT OUTER JOIN (
                SELECT
                    s.user_id AS user_id,
                    count(s.user_id) AS save_count
                FROM
                    saves s
                WHERE
                    s.is_current IS TRUE
                    AND s.save_type = 'track'
                    AND s.is_delete IS FALSE
                    AND s.user_id IN (
                        select
                            user_id
                        from
                            changed_users
                    )
                GROUP BY
                    s.user_id
            ) user_track_save ON user_track_save.user_id = u.user_id
        WHERE
            u.is_current IS TRUE
            AND u.user_id in (
                SELECT
                    user_id
                FROM
                    changed_users
            ) ON CONFLICT (user_id) DO
        UPDATE
        SET
            track_count = EXCLUDED.track_count,
            playlist_count = EXCLUDED.playlist_count,
            album_count = EXCLUDED.album_count,
            follower_count = EXCLUDED.follower_count,
            following_count = EXCLUDED.following_count,
            repost_count = EXCLUDED.repost_count,
            track_save_count = EXCLUDED.track_save_count
    """


def get_latest_blocknumber(session: Session) -> Optional[int]:
    db_block_query = (
        session.query(Block.number).filter(Block.is_current == True).first()
    )
    if db_block_query is None:
        logger.error("Unable to get latest block number")
        return None
    return db_block_query[0]


def _update_aggregate_user(session):
    most_recent_indexed_aggregate_block = get_last_indexed_checkpoint(
        session, AGGREGATE_USER
    )

    latest_blocknumber = get_latest_blocknumber(session)

    logger.info(
        f"index_aggregate_user.py | most_recent_indexed_aggregate_block: {most_recent_indexed_aggregate_block} | latest_blocknumber: {latest_blocknumber}"
    )

    if not most_recent_indexed_aggregate_block:
        # repopulate entire table, if last_checkpoint doesn't exist or last_checkpoint has been cleared
        logger.info(f"index_aggregate_user.py | Repopulating {AGGREGATE_USER}")
        most_recent_indexed_aggregate_block = 0
        session.execute(f"TRUNCATE TABLE {AGGREGATE_USER}")
        logger.info(f"Table '{AGGREGATE_USER}' truncated")
    elif latest_blocknumber == most_recent_indexed_aggregate_block:
        # don't run the query if no new blocknumbers have been indexed
        logger.info("Skipping index_aggregate_user since blocknumber isn't newer")
        return

    # run the upsert query
    logger.info(f"index_aggregate_user.py | Updating {AGGREGATE_USER}")
    session.execute(
        text(UPDATE_AGGREGATE_USER_QUERY),
        {"most_recent_indexed_aggregate_block": most_recent_indexed_aggregate_block},
    )

    # set new block to be the lower bound for the next indexing
    if latest_blocknumber:
        save_indexed_checkpoint(session, AGGREGATE_USER, latest_blocknumber)


# ####### CELERY TASKS ####### #
@celery.task(name="update_aggregate_user", bind=True)
def update_aggregate_user(self):
    # Cache custom task class properties
    # Details regarding custom task context can be found in wiki
    # Custom Task definition can be found in src/app.py
    db = update_aggregate_user.db
    redis = update_aggregate_user.redis
    # Define lock acquired boolean
    have_lock = False
    # Define redis lock object
    lock = f"update_aggregate_table:{AGGREGATE_USER}"
    update_lock = redis.lock(lock, timeout=DEFAULT_UPDATE_TIMEOUT)
    try:
        # Attempt to acquire lock - do not block if unable to acquire
        have_lock = update_lock.acquire(blocking=False)
        if have_lock:
            start_time = time.time()

            with db.scoped_session() as session:
                _update_aggregate_user(session)

            logger.info(
                f"""index_aggregate_user.py | Finished updating {AGGREGATE_USER} in: {time.time()-start_time} sec"""
            )
        else:
            logger.info(f"index_aggregate_user.py | Failed to acquire lock {lock}")
    except Exception as e:
        logger.error(
            "index_aggregate_user.py | Fatal error in main loop", exc_info=True
        )
        raise e
    finally:
        if have_lock:
            update_lock.release()
