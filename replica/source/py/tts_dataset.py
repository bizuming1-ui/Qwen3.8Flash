# coding=utf-8
# Copyright 2026 The Alibaba Qwen team.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Adapted from finetuning/dataset.py at 022e286b98fbec7e1e916cb940cdf532cd9f488e.
Batch size one, local canonical references, no URL/librosa/audio truncation.
"""
import torch
import copy


class TTSDataset:
    def __init__(self,rows,processor,config,reference_mel,max_sequence=1024,cache_bytes=64<<20):
        self.rows,self.processor,self.config=copy.deepcopy(rows),processor,config
        self.reference_mel=reference_mel;self.max_sequence=max_sequence;self.lag_num=-1
        if type(cache_bytes) is not int or not 0<=cache_bytes<=256<<20:raise ValueError('invalid dataset cache budget')
        self.cache_budget=cache_bytes;self.cache_used=0;self._cache={};self.cache_hits=0;self.tokenizer_calls=0

    def __len__(self):return len(self.rows)

    def __getitem__(self,index):
        if index in self._cache:
            self.cache_hits+=1
            tokens,codes=self._cache[index]
            return {'text_ids':tokens.clone(),'audio_codes':codes.clone(),'ref_mel':self.reference_mel}
        row=self.rows[index]
        self.tokenizer_calls+=1
        text=f"<|im_start|>assistant\n{row['text']}<|im_end|>\n<|im_start|>assistant\n"
        tokens=self.processor(text=text,return_tensors='pt',padding=True)['input_ids']
        if tokens.ndim==1:tokens=tokens.unsqueeze(0)
        if tokens.ndim!=2 or tokens.shape[0]!=1 or tokens.shape[1]<9:raise ValueError('unexpected text tokenizer layout')
        tokens=tokens[:,:-5]
        codes=torch.tensor(row['audio_codes'],dtype=torch.long)
        if codes.ndim!=2 or codes.shape[1]!=16 or not len(codes) or (codes<0).any() or (codes>=2048).any():
            raise ValueError('invalid acoustic codes')
        if tokens.shape[1]+len(codes)+8>self.max_sequence:raise ValueError('sample exceeds sequence budget; no truncation performed')
        size=tokens.numel()*tokens.element_size()+codes.numel()*codes.element_size()
        if self.cache_used+size<=self.cache_budget:
            self._cache[index]=(tokens.clone(),codes.clone());self.cache_used+=size
        return {'text_ids':tokens,'audio_codes':codes,'ref_mel':self.reference_mel}

    def collate_fn(self, batch):
        assert self.lag_num == -1

        item_length = [b['text_ids'].shape[1] + b['audio_codes'].shape[0] for b in batch]
        max_length = max(item_length) + 8
        b,t = len(batch),max_length

        input_ids   = torch.zeros((b,t,2),dtype=torch.long)
        codec_ids   = torch.zeros((b,t,16),dtype=torch.long)
        text_embedding_mask     = torch.zeros((b,t),dtype=torch.bool)
        codec_embedding_mask    = torch.zeros((b,t),dtype=torch.bool)
        codec_mask      = torch.zeros((b,t),dtype=torch.bool)
        attention_mask  = torch.zeros((b,t),dtype=torch.long)
        codec_0_labels  = torch.full((b, t), -100, dtype=torch.long)

        for i,data in enumerate(batch):
            text_ids        = data['text_ids']
            audio_codec_0   = data['audio_codes'][:,0]
            audio_codecs    = data['audio_codes']

            text_ids_len = text_ids.shape[1]
            codec_ids_len = audio_codec_0.shape[0]
            
            # text channel
            input_ids[i,  :3, 0] = text_ids[0,:3]
            input_ids[i, 3:7, 0] = self.config.tts_pad_token_id
            input_ids[i,   7, 0] = self.config.tts_bos_token_id
            input_ids[i, 8:8+text_ids_len-3, 0] = text_ids[0,3:]
            input_ids[i,   8+text_ids_len-3, 0] = self.config.tts_eos_token_id
            input_ids[i, 8+text_ids_len-2:8+text_ids_len+codec_ids_len , 0] = self.config.tts_pad_token_id
            text_embedding_mask[i,  :8+text_ids_len+codec_ids_len] = True

            # codec channel
            # input_ids[i,   :3, 1] = 0
            input_ids[i,    3:8 ,1] = torch.tensor(
                                        [
                                            self.config.talker_config.codec_nothink_id,
                                            self.config.talker_config.codec_think_bos_id,
                                            self.config.talker_config.codec_think_eos_id,
                                            0,     # for speaker embedding
                                            self.config.talker_config.codec_pad_id       
                                        ]
                                    )
            input_ids[i,    8:8+text_ids_len-3  ,1] = self.config.talker_config.codec_pad_id
            input_ids[i,    8+text_ids_len-3    ,1] = self.config.talker_config.codec_pad_id
            input_ids[i,    8+text_ids_len-2    ,1] = self.config.talker_config.codec_bos_id
            input_ids[i,    8+text_ids_len-1:8+text_ids_len-1+codec_ids_len,    1] = audio_codec_0
            input_ids[i,    8+text_ids_len-1+codec_ids_len,    1] = self.config.talker_config.codec_eos_token_id

            codec_0_labels[i,    8+text_ids_len-1:8+text_ids_len-1+codec_ids_len] = audio_codec_0
            codec_0_labels[i,    8+text_ids_len-1+codec_ids_len] = self.config.talker_config.codec_eos_token_id

            codec_ids[i, 8+text_ids_len-1:8+text_ids_len-1+codec_ids_len,:] = audio_codecs

            codec_embedding_mask[i, 3:8+text_ids_len+codec_ids_len] = True
            codec_embedding_mask[i, 6] = False       # for speaker embedding

            codec_mask[i,   8+text_ids_len-1:8+text_ids_len-1+codec_ids_len] = True
            attention_mask[i, :8+text_ids_len+codec_ids_len] = True
        
        ref_mels = [data['ref_mel'] for data in batch]
        ref_mels = torch.cat(ref_mels,dim=0)

        return {
            'input_ids':input_ids,
            'ref_mels':ref_mels,
            'attention_mask':attention_mask,
            'text_embedding_mask':text_embedding_mask.unsqueeze(-1),
            'codec_embedding_mask':codec_embedding_mask.unsqueeze(-1),
            'codec_0_labels':codec_0_labels,
            'codec_ids': codec_ids,
            'codec_mask':codec_mask
        }