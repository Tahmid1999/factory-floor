-- Two roles on purpose: ff_owner runs migrations, ff_app serves traffic and
-- gets only the table rights the grants migration hands out.
CREATE ROLE ff_owner LOGIN;
CREATE ROLE ff_app LOGIN;
CREATE DATABASE factory OWNER ff_owner;
CREATE DATABASE factory_test OWNER ff_owner;
