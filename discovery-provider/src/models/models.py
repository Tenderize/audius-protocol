# pylint: disable=too-many-lines
import enum
import logging
from typing import Any

from jsonschema import ValidationError
from sqlalchemy import (
    Boolean,
    Column,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    PrimaryKeyConstraint,
    String,
    Text,
    Unicode,
    UnicodeText,
    event,
    func,
)
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.declarative import declarative_base, declared_attr
from sqlalchemy.orm import relationship, validates
from sqlalchemy.sql import null
from src.model_validator import ModelValidator

Base: Any = declarative_base()
logger = logging.getLogger(__name__)


# Listen for instrumentation of attributes on the base class
# to add a listener on that attribute whenever it is set
@event.listens_for(Base, "attribute_instrument")
def configure_listener(class_, key_, inst):
    # Check that the attribute is a column (we only validate columns)
    if not hasattr(inst.property, "columns"):
        return

    # Listen for set events on the attribute to run our default validations
    @event.listens_for(inst, "set", retval=True)
    def set_(target, value, oldvalue, initiator):
        column_type = getattr(target.__class__, inst.key).type
        if (
            type(column_type) in (String, Text, Unicode, UnicodeText)
            and value
            and isinstance(value, str)
        ):
            value = value.encode("utf-8", "ignore").decode("utf-8", "ignore")
            value = value.replace("\x00", "")
        return value


# field_type is the sqlalchemy type from the model object
def validate_field_helper(field, value, model, field_type):
    # TODO: need to write custom validator for these datetime fields as jsonschema
    # validates datetime in format 2018-11-13T20:20:39+00:00, not a format we use
    # also not totally necessary as these fields are created server side
    if field in ("created_at", "updated_at"):
        return value

    # remove null characters from varchar and text fields
    # Postgres does not support these well and it throws this error if you try to insert
    # `Fatal error in main loop A string literal cannot contain NUL (0x00) characters`
    # the fix is to replace those characters with empty with empty string
    # https://stackoverflow.com/questions/1347646/postgres-error-on-insert-error-invalid-byte-sequence-for-encoding-utf8-0x0
    if type(field_type) in (String, Text) and value:
        value = value.encode("utf-8", "ignore").decode("utf-8", "ignore")
        value = value.replace("\x00", "")

    to_validate = {field: value}
    try:
        ModelValidator.validate(to_validate=to_validate, model=model, field=field)
    except ValidationError as e:
        value = get_default_value(field, value, model, e)
    except BaseException as e:
        logger.error(f"Validation failed: {e}")

    return value


def get_default_value(field, value, model, e):
    field_props = ModelValidator.get_properties_for_field(model, field)

    # type field from the schema. this can either be a string or list
    # required by JSONSchema, cannot be None
    schema_type_field = field_props["type"]
    try:
        default_value = field_props["default"]
    except KeyError:
        default_value = None

    # If the schema indicates this field is equal to object(if string) or contains object(if list) and
    # the default value isn't set in the schema, set to SQL null, otherwise JSONB columns get
    # set to string 'null'.
    # Other fields can be set to their regular defaults or None.
    if not default_value:
        # if schema_type_field is defined as a list, need to check if 'object' is in list, else check string
        if isinstance(schema_type_field, list) and "object" in schema_type_field:
            default_value = null()  # sql null
        elif schema_type_field == "object":
            default_value = null()  # sql null

    logger.warning(
        f"Validation: Setting the default value {default_value} for field {field} "
        f"of type {schema_type_field} because of error: {e}"
    )

    return default_value


def get_fields_to_validate(model):
    try:
        fields = ModelValidator.models_to_schema_and_fields_dict[model]["fields"]
    except BaseException as e:
        logger.error(f"Validation failed: {e}. No validation will occur for {model}")
        fields = [""]

    return fields


class BlockMixin:
    # pylint: disable=property-with-parameters
    @declared_attr
    def __tablename__(self, cls):
        return cls.__name__.lower()

    blockhash = Column(String, primary_key=True)
    number = Column(Integer, nullable=True, unique=True)
    parenthash = Column(String)
    is_current = Column(Boolean)


# inherits from BlockMixin
class Block(Base, BlockMixin):
    __tablename__ = "blocks"

    def __repr__(self):
        return f"<Block(blockhash={self.blockhash},\
parenthash={self.parenthash},number={self.number},\
is_current={self.is_current})>"


# inherits from BlockMixin
class IPLDBlacklistBlock(Base, BlockMixin):
    __tablename__ = "ipld_blacklist_blocks"

    def __repr__(self):
        return f"<IPLDBlacklistBlock(blockhash={self.blockhash},\
    parenthash={self.parenthash},number={self.number}\
    is_current={self.is_current})>"


class BlacklistedIPLD(Base):
    __tablename__ = "ipld_blacklists"

    blockhash = Column(
        String, ForeignKey("ipld_blacklist_blocks.blockhash"), nullable=False
    )
    blocknumber = Column(
        Integer, ForeignKey("ipld_blacklist_blocks.number"), nullable=False
    )
    ipld = Column(String, nullable=False)
    is_blacklisted = Column(Boolean, nullable=False)
    is_current = Column(Boolean, nullable=False, index=True)

    PrimaryKeyConstraint(blockhash, ipld, is_blacklisted, is_current)

    def __repr__(self):
        return f"<BlacklistedIPLD(blockhash={self.blockhash},\
blocknumber={self.blocknumber},ipld={self.ipld}\
is_blacklisted={self.is_blacklisted}, is_current={self.is_current})>"


class User(Base):
    __tablename__ = "users"

    blockhash = Column(String, ForeignKey("blocks.blockhash"), nullable=False)
    blocknumber = Column(Integer, ForeignKey("blocks.number"), nullable=False)
    txhash = Column(String, default="", nullable=False)
    user_id = Column(Integer, nullable=False)
    is_current = Column(Boolean, nullable=False)
    handle = Column(String)
    handle_lc = Column(String, index=True)
    wallet = Column(String, index=True)
    is_creator = Column(Boolean, nullable=False, default=False)
    is_verified = Column(Boolean, nullable=False, default=False, server_default="false")
    name = Column(Text)
    profile_picture = Column(String)
    profile_picture_sizes = Column(String)
    cover_photo = Column(String)
    cover_photo_sizes = Column(String)
    bio = Column(String)
    location = Column(String)
    metadata_multihash = Column(String)
    creator_node_endpoint = Column(String)
    updated_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, nullable=False)
    primary_id = Column(Integer, nullable=True)
    secondary_ids = Column(postgresql.ARRAY(Integer), nullable=True)
    replica_set_update_signer = Column(String, nullable=True)
    has_collectibles = Column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    playlist_library = Column(JSONB, nullable=True)
    is_deactivated = Column(
        Boolean, nullable=False, default=False, server_default="false", index=True
    )

    PrimaryKeyConstraint(is_current, user_id, blockhash, txhash)

    ModelValidator.init_model_schemas("User")
    fields = get_fields_to_validate("User")

    # unpacking args into @validates
    @validates(*fields)
    def validate_field(self, field, value):
        return validate_field_helper(field, value, "User", getattr(User, field).type)

    def __repr__(self):
        return f"<User(blockhash={self.blockhash},\
blocknumber={self.blocknumber},\
txhash={self.txhash},\
user_id={self.user_id},\
is_current={self.is_current},\
handle={self.handle},\
wallet={self.wallet},\
is_creator={self.is_creator},\
name={self.name},\
profile_pic={self.profile_picture},\
profile_pic_sizes={self.profile_picture_sizes},\
cover_photo={self.cover_photo},\
cover_photo_sizes={self.cover_photo_sizes},\
bio={self.bio},\
location={self.location},\
metadata_multihash={self.metadata_multihash},\
creator_node_endpoint={self.creator_node_endpoint},\
primary_id={self.primary_id},\
secondary_ids={self.secondary_ids},\
replica_set_update_signer={self.replica_set_update_signer},\
updated_at={self.updated_at},\
created_at={self.created_at})>"


class Track(Base):
    __tablename__ = "tracks"

    blockhash = Column(String, ForeignKey("blocks.blockhash"), nullable=False)
    blocknumber = Column(Integer, ForeignKey("blocks.number"), nullable=False)
    txhash = Column(String, default="", nullable=False)
    track_id = Column(Integer, nullable=False)
    is_current = Column(Boolean, nullable=False)
    is_delete = Column(Boolean, nullable=False)
    owner_id = Column(Integer, nullable=False)
    route_id = Column(String, nullable=False)
    title = Column(Text, nullable=True)
    length = Column(Integer, nullable=True)
    cover_art = Column(String, nullable=True)
    cover_art_sizes = Column(String, nullable=True)
    tags = Column(String, nullable=True)
    genre = Column(String, nullable=True)
    mood = Column(String, nullable=True)
    credits_splits = Column(String, nullable=True)
    remix_of = Column(postgresql.JSONB, nullable=True)
    create_date = Column(String, nullable=True)
    release_date = Column(String, nullable=True)
    file_type = Column(String, nullable=True)
    description = Column(String, nullable=True)
    license = Column(String, nullable=True)
    isrc = Column(String, nullable=True)
    iswc = Column(String, nullable=True)
    track_segments = Column(postgresql.JSONB, nullable=False)
    metadata_multihash = Column(String, nullable=True)
    download = Column(postgresql.JSONB, nullable=True)
    updated_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, nullable=False)
    is_unlisted = Column(Boolean, nullable=False)
    field_visibility = Column(postgresql.JSONB, nullable=True)
    stem_of = Column(postgresql.JSONB, nullable=True)

    _routes = relationship(  # type: ignore
        "TrackRoute",
        primaryjoin="and_(\
            remote(Track.track_id) == foreign(TrackRoute.track_id),\
            TrackRoute.is_current)",
        lazy="joined",
        viewonly=True,
    )

    user = relationship(
        "User",
        primaryjoin="and_(\
            remote(Track.owner_id) == foreign(User.user_id),\
            User.is_current)",
        lazy="joined",
        viewonly=True,
    )

    @property
    def _slug(self):
        return self._routes[0].slug if self._routes else ""

    @property
    def permalink(self):
        if self.user and self.user[0].handle and self._slug:
            return f"/{self.user[0].handle}/{self._slug}"
        return ""

    PrimaryKeyConstraint(is_current, track_id, blockhash, txhash)

    ModelValidator.init_model_schemas("Track")
    fields = get_fields_to_validate("Track")

    # unpacking args into @validates
    @validates(*fields)
    def validate_field(self, field, value):
        return validate_field_helper(field, value, "Track", getattr(Track, field).type)

    def __repr__(self):
        return (
            f"<Track("
            f"blockhash={self.blockhash},"
            f"blocknumber={self.blocknumber},"
            f"txhash={self.txhash},"
            f"track_id={self.track_id},"
            f"is_current={self.is_current},"
            f"is_delete={self.is_delete},"
            f"owner_id={self.owner_id},"
            f"route_id={self.route_id},"
            f"title={self.title},"
            f"length={self.length},"
            f"cover_art={self.cover_art},"
            f"cover_art_sizes={self.cover_art_sizes},"
            f"tags={self.tags},"
            f"genre={self.genre},"
            f"mood={self.mood},"
            f"credits_splits={self.credits_splits},"
            f"remix_of={self.remix_of},"
            f"create_date={self.create_date},"
            f"release_date={self.release_date},"
            f"file_type={self.file_type},"
            f"description={self.description},"
            f"license={self.license},"
            f"isrc={self.isrc},"
            f"iswc={self.iswc},"
            f"track_segments={self.track_segments},"
            f"metadata_multihash={self.metadata_multihash},"
            f"download={self.download},"
            f"updated_at={self.updated_at},"
            f"created_at={self.created_at},"
            f"stem_of={self.stem_of},"
            f"permalink={self.permalink},"
            f"user={self.user}"
            ")>"
        )


class Playlist(Base):
    __tablename__ = "playlists"
    blockhash = Column(String, ForeignKey("blocks.blockhash"), nullable=False)
    blocknumber = Column(Integer, ForeignKey("blocks.number"), nullable=False)
    txhash = Column(String, default="", nullable=False)
    playlist_id = Column(Integer, nullable=False)
    playlist_owner_id = Column(Integer, nullable=False)
    is_album = Column(Boolean, nullable=False)
    is_private = Column(Boolean, nullable=False)
    playlist_name = Column(String)
    playlist_contents = Column(JSONB, nullable=False)
    playlist_image_multihash = Column(String)
    playlist_image_sizes_multihash = Column(String)
    description = Column(String)
    upc = Column(String)
    is_current = Column(Boolean, nullable=False)
    is_delete = Column(Boolean, nullable=False)
    last_added_to = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, nullable=False)

    PrimaryKeyConstraint(is_current, playlist_id, playlist_owner_id, blockhash, txhash)

    ModelValidator.init_model_schemas("Playlist")
    fields = ["playlist_name", "description"]

    # unpacking args into @validates
    @validates(*fields)
    def validate_field(self, field, value):
        return validate_field_helper(
            field, value, "Playlist", getattr(Playlist, field).type
        )

    def __repr__(self):
        return f"<Playlist(blockhash={self.blockhash},\
blocknumber={self.blocknumber},\
txhash={self.txhash},\
playlist_id={self.playlist_id},\
playlist_owner_id={self.playlist_owner_id},\
is_album={self.is_album},\
is_private={self.is_private},\
playlist_name={self.playlist_name},\
playlist_contents={self.playlist_contents},\
playlist_image_multihash={self.playlist_image_multihash},\
playlist_image_sizes_multihash={self.playlist_image_sizes_multihash},\
description={self.description},\
upc={self.upc}\
is_current={self.is_current},\
is_delete={self.is_delete},\
updated_at={self.updated_at},\
created_at={self.created_at})>"


class RepostType(str, enum.Enum):
    track = "track"
    playlist = "playlist"
    album = "album"


class Repost(Base):
    __tablename__ = "reposts"

    blockhash = Column(String, ForeignKey("blocks.blockhash"), nullable=False)
    blocknumber = Column(Integer, ForeignKey("blocks.number"), nullable=False)
    txhash = Column(String, default="", nullable=False)
    user_id = Column(Integer, nullable=False)
    repost_item_id = Column(Integer, nullable=False)
    repost_type = Column(Enum(RepostType), nullable=False)
    is_current = Column(Boolean, nullable=False)
    is_delete = Column(Boolean, nullable=False)
    created_at = Column(DateTime, nullable=False)

    PrimaryKeyConstraint(
        user_id, repost_item_id, repost_type, is_current, blockhash, txhash
    )

    def __repr__(self):
        return f"<Repost(blockhash={self.blockhash},\
blocknumber={self.blocknumber},\
txhash={self.txhash},\
user_id={self.user_id},\
repost_item_id={self.repost_item_id},\
repost_type={self.repost_type},\
is_current={self.is_current},\
is_delete={self.is_delete},\
created_at={self.created_at})>"


class Follow(Base):
    __tablename__ = "follows"

    blockhash = Column(String, ForeignKey("blocks.blockhash"), nullable=False)
    blocknumber = Column(Integer, ForeignKey("blocks.number"), nullable=False)
    txhash = Column(String, default="", nullable=False)
    follower_user_id = Column(Integer, nullable=False, index=True)
    followee_user_id = Column(Integer, nullable=False, index=True)
    is_current = Column(Boolean, nullable=False)
    is_delete = Column(Boolean, nullable=False)
    created_at = Column(DateTime, nullable=False)

    PrimaryKeyConstraint(
        is_current, follower_user_id, followee_user_id, blockhash, txhash
    )

    def __repr__(self):
        return f"<Follow(blockhash={self.blockhash},\
blocknumber={self.blocknumber},\
txhash={self.txhash},\
follower_user_id={self.follower_user_id},\
followee_user_id={self.followee_user_id},\
is_current={self.is_current},\
is_delete={self.is_delete},\
created_at={self.created_at})>"


class SaveType(str, enum.Enum):
    track = "track"
    playlist = "playlist"
    album = "album"


class Save(Base):
    __tablename__ = "saves"

    blockhash = Column(String, ForeignKey("blocks.blockhash"), nullable=False)
    blocknumber = Column(Integer, ForeignKey("blocks.number"), nullable=False)
    txhash = Column(String, default="", nullable=False)
    user_id = Column(Integer, nullable=False)
    save_item_id = Column(Integer, nullable=False)
    save_type = Column(Enum(SaveType), nullable=False)
    created_at = Column(DateTime, nullable=False)
    is_current = Column(Boolean, nullable=False)
    is_delete = Column(Boolean, nullable=False)

    PrimaryKeyConstraint(
        is_current, user_id, save_item_id, save_type, blockhash, txhash
    )

    def __repr__(self):
        return f"<Save(blockhash={self.blockhash},\
blocknumber={self.blocknumber},\
txhash={self.txhash},\
user_id={self.user_id},\
save_item_id={self.save_item_id},\
created_at={self.created_at},\
save_type={self.save_type},\
is_current={self.is_current},\
is_delete={self.is_delete})>"


class Stem(Base):
    __tablename__ = "stems"

    parent_track_id = Column(Integer, nullable=False, index=False)
    child_track_id = Column(Integer, nullable=False, index=False)
    PrimaryKeyConstraint(parent_track_id, child_track_id)

    def __repr__(self):
        return f"<Stem(parent_track_id={self.parent_track_id},\
child_track_id={self.child_track_id})>"


class Remix(Base):
    __tablename__ = "remixes"

    parent_track_id = Column(Integer, nullable=False, index=False)
    child_track_id = Column(Integer, nullable=False, index=False)
    PrimaryKeyConstraint(parent_track_id, child_track_id)

    def __repr__(self):
        return f"<Remix(parent_track_id={self.parent_track_id},\
child_track_id={self.child_track_id})>"


class Play(Base):
    __tablename__ = "plays"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, nullable=True, index=False)
    source = Column(String, nullable=True, index=False)
    play_item_id = Column(Integer, nullable=False, index=False)
    slot = Column(Integer, nullable=True, index=True)
    signature = Column(String, nullable=True, index=False)
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    Index("ix_plays_user_play_item", "play_item_id", "user_id", unique=False)
    Index(
        "ix_plays_user_play_item_date",
        "play_item_id",
        "user_id",
        "created_at",
        unique=False,
    )
    Index("ix_plays_sol_signature", "play_item_id", "signature", unique=False)

    def __repr__(self):
        return f"<Play(\
id={self.id},\
user_id={self.user_id},\
source={self.source},\
play_item_id={self.play_item_id}\
slot={self.slot}\
signature={self.signature}\
updated_at={self.updated_at}\
created_at={self.created_at})>"


class AggregatePlays(Base):
    __tablename__ = "aggregate_plays"

    play_item_id = Column(Integer, primary_key=True, nullable=False, index=True)
    count = Column(Integer, nullable=False, index=False)

    Index("play_item_id_idx", "play_item_id", unique=False)

    def __repr__(self):
        return f"<AggregatePlays(\
play_item_id={self.play_item_id},\
count={self.count})>"


class HourlyPlayCounts(Base):
    __tablename__ = "hourly_play_counts"

    hourly_timestamp = Column(DateTime, primary_key=True, nullable=False)
    play_count = Column(Integer, nullable=False, index=False)

    def __repr__(self):
        return f"<HourlyPlayCounts(\
hourly_timestamp={self.hourly_timestamp},\
play_count={self.play_count})>"


class IndexingCheckpoints(Base):
    __tablename__ = "indexing_checkpoints"

    tablename = Column(String, primary_key=True, nullable=False, index=False)
    last_checkpoint = Column(Integer, nullable=False, index=False)

    def __repr__(self):
        return f"<IndexingCheckpoints(\
tablename={self.tablename},\
last_checkpoint={self.last_checkpoint}>"


class RouteMetrics(Base):
    __tablename__ = "route_metrics"

    id = Column(Integer, primary_key=True)
    version = Column(String, nullable=True)
    route_path = Column(String, nullable=False)
    query_string = Column(String, nullable=True, default="")
    count = Column(Integer, nullable=False)
    ip = Column(String, nullable=False)
    timestamp = Column(DateTime, nullable=False, default=func.now())
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    def __repr__(self):
        return f"<RouteMetrics(\
version={self.version},\
route_path={self.route_path},\
query_string={self.query_string},\
count={self.count},\
ip={self.ip},\
timestamp={self.timestamp},\
created_at={self.created_at},\
updated_at={self.updated_at}"


class AggregateDailyUniqueUsersMetrics(Base):
    __tablename__ = "aggregate_daily_unique_users_metrics"

    id = Column(Integer, primary_key=True)
    count = Column(Integer, nullable=False)
    summed_count = Column(Integer, nullable=True)
    timestamp = Column(Date, nullable=False)  # zeroed out to the day
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    def __repr__(self):
        return f"<AggregateDailyUniqueUsersMetrics(\
count={self.count},\
timestamp={self.timestamp},\
created_at={self.created_at},\
updated_at={self.updated_at}"


class AggregateDailyTotalUsersMetrics(Base):
    __tablename__ = "aggregate_daily_total_users_metrics"

    id = Column(Integer, primary_key=True)
    count = Column(Integer, nullable=False)
    timestamp = Column(Date, nullable=False)  # zeroed out to the day
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    def __repr__(self):
        return f"<AggregateDailyTotalUsersMetrics(\
count={self.count},\
timestamp={self.timestamp},\
created_at={self.created_at},\
updated_at={self.updated_at}"


class AggregateMonthlyUniqueUsersMetrics(Base):
    __tablename__ = "aggregate_monthly_unique_users_metrics"

    id = Column(Integer, primary_key=True)
    count = Column(Integer, nullable=False)
    summed_count = Column(Integer, nullable=True)
    timestamp = Column(Date, nullable=False)  # first day of month
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    def __repr__(self):
        return f"<AggregateMonthlyUniqueUsersMetrics(\
count={self.count},\
timestamp={self.timestamp},\
created_at={self.created_at},\
updated_at={self.updated_at}"


class AggregateMonthlyTotalUsersMetrics(Base):
    __tablename__ = "aggregate_monthly_total_users_metrics"

    id = Column(Integer, primary_key=True)
    count = Column(Integer, nullable=False)
    timestamp = Column(Date, nullable=False)  # first day of month
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    def __repr__(self):
        return f"<AggregateMonthlyTotalUsersMetrics(\
count={self.count},\
timestamp={self.timestamp},\
created_at={self.created_at},\
updated_at={self.updated_at}"


class AppNameMetrics(Base):
    __tablename__ = "app_name_metrics"

    id = Column(Integer, primary_key=True)
    application_name = Column(String, nullable=False)
    count = Column(Integer, nullable=False)
    ip = Column(String, nullable=True)
    timestamp = Column(DateTime, nullable=False, default=func.now())
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    def __repr__(self):
        return f"<AppNameMetrics(\
application_name={self.application_name},\
count={self.count},\
ip={self.ip},\
timestamp={self.timestamp},\
created_at={self.created_at},\
updated_at={self.updated_at}"


class AggregateDailyAppNameMetrics(Base):
    __tablename__ = "aggregate_daily_app_name_metrics"

    id = Column(Integer, primary_key=True)
    application_name = Column(String, nullable=False)
    count = Column(Integer, nullable=False)
    timestamp = Column(Date, nullable=False)  # zeroed out to the day
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    def __repr__(self):
        return f"<AggregateDailyAppNameMetrics(\
application_name={self.application_name},\
count={self.count},\
timestamp={self.timestamp},\
created_at={self.created_at},\
updated_at={self.updated_at}"


class AggregateMonthlyAppNameMetrics(Base):
    __tablename__ = "aggregate_monthly_app_name_metrics"

    id = Column(Integer, primary_key=True)
    application_name = Column(String, nullable=False)
    count = Column(Integer, nullable=False)
    timestamp = Column(Date, nullable=False)  # first day of month
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    def __repr__(self):
        return f"<AggregateMonthlyAppNameMetrics(\
application_name={self.application_name},\
count={self.count},\
timestamp={self.timestamp},\
created_at={self.created_at},\
updated_at={self.updated_at}"


class RouteMetricsDayMatview(Base):
    __tablename__ = "route_metrics_day_bucket"

    time = Column(DateTime, nullable=False, primary_key=True)
    unique_count = Column(Integer, nullable=False)
    count = Column(Integer, nullable=False)

    def __repr__(self):
        return f"<RouteMetricsDayMatview(\
unique_count={self.unique_count},\
count={self.count},\
time={self.time})>"


class RouteMetricsMonthMatview(Base):
    __tablename__ = "route_metrics_month_bucket"

    time = Column(DateTime, nullable=False, primary_key=True)
    unique_count = Column(Integer, nullable=False)
    count = Column(Integer, nullable=False)

    def __repr__(self):
        return f"<RouteMetricsMonthMatview(\
unique_count={self.unique_count},\
count={self.count},\
time={self.time})>"


class RouteMetricsTrailingWeek(Base):
    __tablename__ = "route_metrics_trailing_week"

    unique_count = Column(Integer, nullable=False)
    count = Column(Integer, nullable=False)
    PrimaryKeyConstraint(unique_count, count)

    def __repr__(self):
        return f"<RouteMetricsTrailingWeek(\
unique_count={self.unique_count},\
count={self.count})>"


class RouteMetricsTrailingMonth(Base):
    __tablename__ = "route_metrics_trailing_month"

    unique_count = Column(Integer, nullable=False)
    count = Column(Integer, nullable=False)
    PrimaryKeyConstraint(unique_count, count)

    def __repr__(self):
        return f"<RouteMetricsTrailingMonth(\
unique_count={self.unique_count},\
count={self.count})>"


class RouteMetricsAllTime(Base):
    __tablename__ = "route_metrics_all_time"

    unique_count = Column(Integer, nullable=False)
    count = Column(Integer, nullable=False)
    PrimaryKeyConstraint(unique_count, count)

    def __repr__(self):
        return f"<RouteMetricsTrailingAllTime(\
unique_count={self.unique_count},\
count={self.count})>"


class AppMetricsTrailingWeek(Base):
    __tablename__ = "app_name_metrics_trailing_week"

    count = Column(Integer, nullable=False)
    name = Column(String, nullable=False, primary_key=True)

    def __repr__(self):
        return f"<AppMetricsTrailingWeek(\
name={self.name},\
count={self.count})>"


class AppMetricsTrailingMonth(Base):
    __tablename__ = "app_name_metrics_trailing_month"

    count = Column(Integer, nullable=False)
    name = Column(String, nullable=False, primary_key=True)

    def __repr__(self):
        return f"<AppMetricsTrailingMonth(\
name={self.name},\
count={self.count})>"


class AppMetricsAllTime(Base):
    __tablename__ = "app_name_metrics_all_time"

    count = Column(Integer, nullable=False)
    name = Column(String, nullable=False, primary_key=True)

    def __repr__(self):
        return f"<AppMetricsAllTime(\
name={self.name},\
count={self.count})>"


class TagTrackUserMatview(Base):
    __tablename__ = "tag_track_user"

    tag = Column(String, nullable=False)
    track_id = Column(Integer, nullable=False)
    owner_id = Column(Integer, nullable=False)

    PrimaryKeyConstraint(tag, track_id, owner_id)

    def __repr__(self):
        return f"<TagTrackUserMatview(\
tag={self.tag},\
track_id={self.track_id},\
owner_id={self.owner_id})>"


class URSMContentNode(Base):
    __tablename__ = "ursm_content_nodes"
    blockhash = Column(String, ForeignKey("blocks.blockhash"), nullable=False)
    blocknumber = Column(Integer, ForeignKey("blocks.number"), nullable=False)
    txhash = Column(String, default="", nullable=False)
    is_current = Column(Boolean, nullable=False)
    cnode_sp_id = Column(Integer, nullable=False)
    delegate_owner_wallet = Column(String, nullable=False)
    owner_wallet = Column(String, nullable=False)
    proposer_sp_ids = Column(postgresql.ARRAY(Integer), nullable=False)
    proposer_1_delegate_owner_wallet = Column(String, nullable=False)
    proposer_2_delegate_owner_wallet = Column(String, nullable=False)
    proposer_3_delegate_owner_wallet = Column(String, nullable=False)
    endpoint = Column(String, nullable=True)
    created_at = Column(DateTime, nullable=False)

    PrimaryKeyConstraint(is_current, cnode_sp_id, blockhash, txhash)

    def __repr__(self):
        return f"<URSMContentNode(blockhash={self.blockhash},\
blocknumber={self.blocknumber},\
txhash={self.txhash},\
is_current={self.is_current},\
cnode_sp_id={self.cnode_sp_id},\
delegate_owner_wallet={self.delegate_owner_wallet},\
owner_wallet={self.owner_wallet},\
proposer_sp_ids={self.proposer_sp_ids},\
proposer_1_delegate_owner_wallet={self.proposer_1_delegate_owner_wallet},\
proposer_2_delegate_owner_wallet={self.proposer_2_delegate_owner_wallet},\
proposer_3_delegate_owner_wallet={self.proposer_3_delegate_owner_wallet},\
endpoint={self.endpoint})>"


class UserBalance(Base):
    __tablename__ = "user_balances"

    user_id = Column(Integer, nullable=False, primary_key=True)
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    # balance in Wei
    balance = Column(String, nullable=False)
    associated_wallets_balance = Column(String, nullable=False)
    associated_sol_wallets_balance = Column(String, nullable=False)

    # wAudio balance
    waudio = Column(String, nullable=False)

    def __repr__(self):
        return f"<UserBalance(\
user_id={self.user_id},\
balance={self.balance},\
associated_wallets_balance={self.associated_wallets_balance}\
associated_sol_wallets_balance={self.associated_sol_wallets_balance}\
waudio={self.waudio})>"


class UserBalanceChange(Base):
    __tablename__ = "user_balance_changes"

    user_id = Column(Integer, nullable=False, primary_key=True)
    blocknumber = Column(Integer, ForeignKey("blocks.number"), nullable=False)
    current_balance = Column(String, nullable=False)
    previous_balance = Column(String, nullable=False)
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    def __repr__(self):
        return f"<UserBalanceChange(\
user_id={self.user_id},\
blocknumber={self.blocknumber},\
current_balance={self.current_balance},\
previous_balance={self.previous_balance})>"


class WalletChain(str, enum.Enum):
    eth = "eth"
    sol = "sol"


class AssociatedWallet(Base):
    __tablename__ = "associated_wallets"
    blockhash = Column(String, ForeignKey("blocks.blockhash"), nullable=False)
    blocknumber = Column(Integer, ForeignKey("blocks.number"), nullable=False)
    is_current = Column(Boolean, nullable=False)
    is_delete = Column(Boolean, nullable=False)
    id = Column(Integer, nullable=False, primary_key=True)
    user_id = Column(Integer, nullable=False, index=True)
    wallet = Column(String, nullable=False, index=True)
    chain = Column(Enum(WalletChain), nullable=False)

    def __repr__(self):
        return f"<AssociatedWallet(blockhash={self.blockhash},\
blocknumber={self.blocknumber},\
is_current={self.is_current},\
is_delete={self.is_delete},\
id={self.id},\
user_id={self.user_id},\
wallet={self.wallet}\
chain={self.chain})>"


class AggregateUser(Base):
    __tablename__ = "aggregate_user"

    user_id = Column(Integer, primary_key=True, nullable=False, index=True)
    track_count = Column(Integer, nullable=False)
    playlist_count = Column(Integer, nullable=False)
    album_count = Column(Integer, nullable=False)
    follower_count = Column(Integer, nullable=False)
    following_count = Column(Integer, nullable=False)
    repost_count = Column(Integer, nullable=False)
    track_save_count = Column(Integer, nullable=False)

    Index("aggregate_user_idx", "user_id", unique=True)

    def __repr__(self):
        return f"<AggregateUser(\
user_id={self.user_id},\
track_count={self.track_count},\
playlist_count={self.playlist_count},\
album_count={self.album_count},\
follower_count={self.follower_count},\
following_count={self.following_count},\
repost_count={self.repost_count},\
track_save_count={self.track_save_count})>"


class AggregateTrack(Base):
    __tablename__ = "aggregate_track"

    track_id = Column(Integer, primary_key=True, nullable=False, index=True)
    repost_count = Column(Integer, nullable=False)
    save_count = Column(Integer, nullable=False)

    Index("aggregate_track_idx", "track_id", unique=True)

    def __repr__(self):
        return f"<AggregateTrack(\
track_id={self.track_id},\
repost_count={self.repost_count},\
save_count={self.save_count})>"


class AggregatePlaylist(Base):
    __tablename__ = "aggregate_playlist"

    playlist_id = Column(Integer, primary_key=True, nullable=False, index=True)
    is_album = Column(Boolean, nullable=False)
    repost_count = Column(Integer, nullable=False)
    save_count = Column(Integer, nullable=False)

    Index("aggregate_playlist_idx", "playlist_id", unique=True)

    def __repr__(self):
        return f"<AggregatePlaylist(\
playlist_id={self.playlist_id},\
is_album={self.is_album},\
repost_count={self.repost_count},\
save_count={self.save_count})>"


class SkippedTransactionLevel(str, enum.Enum):
    node = "node"
    network = "network"


class SkippedTransaction(Base):
    __tablename__ = "skipped_transactions"

    id = Column(Integer, primary_key=True, nullable=False)
    blocknumber = Column(Integer, nullable=False)
    blockhash = Column(String, nullable=False)
    txhash = Column(String, nullable=False)
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )
    level = Column(
        Enum(SkippedTransactionLevel),
        nullable=False,
        default=SkippedTransactionLevel.node,
    )

    def __repr__(self):
        return f"<SkippedTransaction(\
id={self.id},\
blocknumber={self.blocknumber},\
blockhash={self.blockhash},\
txhash={self.txhash},\
level={self.level},\
created_at={self.created_at},\
updated_at={self.updated_at})>"


class EthBlock(Base):
    __tablename__ = "eth_blocks"
    last_scanned_block = Column(Integer, primary_key=True, nullable=False)
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    def __repr__(self):
        return f"<EthBlock(\
last_scanned_block={self.last_scanned_block},\
created_at={self.created_at},\
updated_at={self.updated_at})>"


class ChallengeType(str, enum.Enum):
    boolean = "boolean"
    numeric = "numeric"
    aggregate = "aggregate"
    trending = "trending"


class Challenge(Base):
    """Represents a particular challenge type"""

    __tablename__ = "challenges"

    # Identifies this challenge
    id = Column(String, primary_key=True, nullable=False, index=True)
    type = Column(Enum(ChallengeType), nullable=False)
    # The amount of wAudio to disburse (8 decimals)
    amount = Column(String, nullable=False)
    # Whether the challenge is currently active
    active = Column(Boolean, nullable=False)
    # Optional field to support numeric challenges,
    # representing the number of steps to complete the challenge
    step_count = Column(Integer)
    # Optional field for non-retroactive challenges -
    # if set, events emitted prior to the starting_block
    # will be ignord.
    starting_block = Column(Integer)

    def __repr__(self):
        return f"<Challenge(\
id={self.id},\
type={self.type},\
amount={self.amount},\
active={self.active},\
step_count={self.step_count},\
starting_block={self.starting_block},\
"


class UserChallenge(Base):
    """Represents user progress through a particular challenge."""

    __tablename__ = "user_challenges"

    challenge_id = Column(String, ForeignKey("challenges.id"), nullable=False)
    user_id = Column(Integer, nullable=False)
    specifier = Column(String, nullable=False)
    is_complete = Column(Boolean, nullable=False)
    completed_blocknumber = Column(Integer, ForeignKey("blocks.number"), nullable=True)
    current_step_count = Column(Integer)

    PrimaryKeyConstraint(challenge_id, specifier)

    def __repr__(self):
        return f"<UserChallenge(\
challenge_id={self.challenge_id},\
user_id={self.user_id},\
specifier={self.specifier},\
is_complete={self.is_complete},\
completed_blocknumber={self.completed_blocknumber},\
current_step_count={self.current_step_count})>"


class ChallengeDisbursement(Base):
    __tablename__ = "challenge_disbursements"

    challenge_id = Column(String, ForeignKey("challenges.id"), nullable=False)
    user_id = Column(Integer, nullable=False)
    amount = Column(String, nullable=False)
    signature = Column(String, nullable=False)
    slot = Column(Integer, nullable=False)
    specifier = Column(String, nullable=False)

    PrimaryKeyConstraint(challenge_id, specifier)

    def __repr__(self):
        return f"<ChallengeDisbursement,\
challenge_id={self.challenge_id},\
user_id={self.user_id},\
amount={self.amount},\
signature={self.signature},\
slot={self.slot},\
specifier={self.specifier})>"


class ProfileCompletionChallenge(Base):
    __tablename__ = "challenge_profile_completion"

    user_id = Column(Integer, nullable=False, primary_key=True)
    profile_description = Column(Boolean, nullable=False)
    profile_name = Column(Boolean, nullable=False)
    profile_picture = Column(Boolean, nullable=False)
    profile_cover_photo = Column(Boolean, nullable=False)
    follows = Column(Boolean, nullable=False)
    favorites = Column(Boolean, nullable=False)
    reposts = Column(Boolean, nullable=False)

    def __repr__(self):
        return f"<ProfileCompletionChallenge,\
user_id={self.user_id},\
profile_description={self.profile_description},\
profile_name={self.profile_name},\
profile_picture={self.profile_picture},\
profile_cover_photo={self.profile_cover_photo},\
follows_complete={self.follows},\
favorites_complete={self.favorites},\
reposts_complete={self.reposts})>"


class ListenStreakChallenge(Base):
    __tablename__ = "challenge_listen_streak"

    user_id = Column(Integer, nullable=False, primary_key=True)
    last_listen_date = Column(DateTime)
    listen_streak = Column(Integer, nullable=False)

    def __repr__(self):
        return f"<ListenStreakChallenge,\
user_id={self.user_id},\
last_listen_date={self.last_listen_date},\
listen_streak={self.listen_streak})>"


class UserListeningHistory(Base):
    __tablename__ = "user_listening_history"

    user_id = Column(Integer, primary_key=True, nullable=False, index=True)
    listening_history = Column(JSONB, nullable=False, index=False)
    # listening_history JSON schema
    # [
    #   {"track_id": 1, "timestamp": "2011-01-01 00:00:00"},
    #   {"track_id": 2, "timestamp": "2012-02-02 00:00:00"}
    # ]

    Index("user_id", "listening_history", unique=True)

    def __repr__(self):
        return f"<UserListeningHistory(\
user_id={self.user_id},\
listening_history={self.listening_history})>"
