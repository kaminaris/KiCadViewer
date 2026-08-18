FROM emscripten/emsdk:3.1.74

ARG KICAD_ZINT_REV=fd4aa7e2d8229b53801c7cfe618d8e110c41263b

RUN git clone --filter=blob:none --no-checkout https://gitlab.com/kicad/code/kicad.git /workspace/kicad \
    && cd /workspace/kicad \
    && git sparse-checkout set thirdparty/zint \
    && git fetch --depth 1 origin ${KICAD_ZINT_REV} \
    && git checkout --detach FETCH_HEAD

COPY bindings.cpp build.sh /workspace/
RUN chmod +x /workspace/build.sh

ENTRYPOINT ["/workspace/build.sh"]
