<script setup lang="ts">
import axios from 'axios';
import { fromA, fromB } from '@/edge/barrelA';
import { useHttp, fetcher, v1get } from '@/edge/useHttp';
import { useOptStore } from '@/edge/optStore';
import { ApiPath } from '@/edge/paths';

const http = useHttp();
const opt = useOptStore();
const endpoint = (window as any).cfg.endpoint as string;

function barrel() { axios.get(fromA); axios.get(fromB); }
function wrapped() { http.get('/users'); }
function defaults() { fetcher('/users'); }
function partialBase() { v1get('/users'); }
function store() { opt.refresh(); }
function enumUrl() { axios.get(ApiPath.LIST); }
function plusEq(o: any) {
  let u = '/api/q?x=1';
  if (o.a) u += '&a=' + o.a;
  if (o.b) u += '&b=' + o.b;
  axios.get(u);
}
function selfRef(o: any) {
  let u = '/api/self';
  if (o.a0) u = u + '&a0=' + o.a0;
  if (o.a1) u = u + '&a1=' + o.a1;
  if (o.a2) u = u + '&a2=' + o.a2;
  if (o.a3) u = u + '&a3=' + o.a3;
  if (o.a4) u = u + '&a4=' + o.a4;
  if (o.a5) u = u + '&a5=' + o.a5;
  if (o.a6) u = u + '&a6=' + o.a6;
  if (o.a7) u = u + '&a7=' + o.a7;
  if (o.a8) u = u + '&a8=' + o.a8;
  if (o.a9) u = u + '&a9=' + o.a9;
  if (o.b0) u = u + '&b0=' + o.b0;
  if (o.b1) u = u + '&b1=' + o.b1;
  if (o.b2) u = u + '&b2=' + o.b2;
  if (o.b3) u = u + '&b3=' + o.b3;
  if (o.b4) u = u + '&b4=' + o.b4;
  if (o.b5) u = u + '&b5=' + o.b5;
  if (o.b6) u = u + '&b6=' + o.b6;
  if (o.b7) u = u + '&b7=' + o.b7;
  if (o.b8) u = u + '&b8=' + o.b8;
  if (o.b9) u = u + '&b9=' + o.b9;
  if (o.c0) u = u + '&c0=' + o.c0;
  if (o.c1) u = u + '&c1=' + o.c1;
  if (o.c2) u = u + '&c2=' + o.c2;
  if (o.c3) u = u + '&c3=' + o.c3;
  if (o.c4) u = u + '&c4=' + o.c4;
  axios.get(u);
}
function unknownUrl() { axios.get(endpoint); }
function unknownMethod() { axios.request({ method: (globalThis as any).M, url: '/um' }); }
// 같은 API 를 부르는 진입 함수 7개 → 라벨 "외 4"
function m1() { axios.get('/api/many'); } function m2() { axios.get('/api/many'); } function m3() { axios.get('/api/many'); }
function m4() { axios.get('/api/many'); } function m5() { axios.get('/api/many'); } function m6() { axios.get('/api/many'); } function m7() { axios.get('/api/many'); }
</script>
<template><div /></template>
